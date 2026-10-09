/**
 * Os estágios de stream do canal de mídia, um a um e sem rede.
 *
 * O que se confere aqui é o que justifica eles serem streams: ordem,
 * prioridade e o que acontece quando quem está do outro lado não dá conta.
 * São propriedades que não aparecem em teste de caminho feliz — com o
 * cliente em dia, uma fila ingênua se comporta igual a esta.
 */
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, it } from 'node:test';
import type { WebSocket } from 'ws';
import type { SignalEventFrame, SignalResponseFrame, SignalServerFrame } from '@telecord/shared';
import { decodeFrame, FrameDecoder, FrameEncoder, type DecodedFrame } from '../src/signal/frames';
import { OutboundQueue } from '../src/signal/outbound';
import { SignalSession } from '../src/signal/session';
import type { WebSocketDuplex } from '../src/signal/socketStream';

function response(id: number): SignalResponseFrame {
  return { t: 'res', id, ok: true, d: {} };
}

function speakers(peerId: string): SignalEventFrame<'speakers'> {
  return { t: 'evt', e: 'speakers', d: { speakers: [{ peerId, volume: -20 }] } };
}

function trackClosed(producerId: string): SignalEventFrame<'track:closed'> {
  return { t: 'evt', e: 'track:closed', d: { roomSlug: 'sala', peerId: 'ana', producerId } };
}

/** Lê exatamente `count` quadros, um por vez — um consumidor que só pede quando quer. */
async function take(queue: Readable, count: number): Promise<SignalServerFrame[]> {
  const out: SignalServerFrame[] = [];
  const iterator = queue[Symbol.asyncIterator]();
  while (out.length < count) {
    const next = await iterator.next();
    if (next.done === true) break;
    out.push(next.value as SignalServerFrame);
  }
  return out;
}

describe('decodificador de quadros', () => {
  it('aceita um pedido bem formado', () => {
    const decoded = decodeFrame('{"t":"req","id":7,"m":"ping","d":{}}');
    assert.deepEqual(decoded, { ok: true, frame: { t: 'req', id: 7, m: 'ping', d: {} } });
  });

  it('pedido sem `d` vira objeto vazio, para ninguém ler campo de undefined', () => {
    const decoded = decodeFrame('{"t":"req","id":1,"m":"ping"}');
    assert.equal(decoded.ok, true);
    assert.deepEqual(decoded.ok && decoded.frame.d, {});
  });

  it('recusa o que não é pedido, sem lançar', () => {
    const recusados: unknown[] = [
      Buffer.from('{"t":"req","id":1,"m":"ping"}'),
      'isto não é json',
      '[]',
      'null',
      '{"t":"res","id":1,"ok":true}',
      '{"t":"req","id":-1,"m":"ping"}',
      '{"t":"req","id":1.5,"m":"ping"}',
      '{"t":"req","id":"1","m":"ping"}',
      '{"t":"req","id":1,"m":"apagarTudo"}',
      '{"t":"req","id":1,"m":"ping","d":[]}',
      '{"t":"req","id":1,"m":"ping","d":"texto"}',
    ];
    for (const quadro of recusados) {
      assert.equal(decodeFrame(quadro).ok, false, `deveria recusar ${String(quadro)}`);
    }
  });

  it('num pipeline, quadro inválido segue adiante marcado — não derruba o stream', async () => {
    const saida: DecodedFrame[] = [];
    await pipeline(
      Readable.from(['{"t":"req","id":1,"m":"ping"}', 'lixo', '{"t":"req","id":2,"m":"ping"}']),
      new FrameDecoder(),
      new Writable({
        objectMode: true,
        write(chunk: DecodedFrame, _encoding, callback) {
          saida.push(chunk);
          callback();
        },
      }),
    );
    assert.deepEqual(
      saida.map((decoded) => decoded.ok),
      [true, false, true],
    );
  });
});

describe('fila de saída', () => {
  it('entrega o que é crítico na ordem em que entrou', async () => {
    const queue = new OutboundQueue(100, () => assert.fail('não deveria estourar'));
    for (let id = 1; id <= 5; id += 1) queue.enqueue(response(id));
    queue.finish();
    const frames = await queue.toArray();
    assert.deepEqual(
      frames.map((frame) => (frame as SignalResponseFrame).id),
      [1, 2, 3, 4, 5],
    );
  });

  it('sem ninguém lendo, o volátil se sobrescreve em vez de acumular', async () => {
    const queue = new OutboundQueue(100, () => assert.fail('não deveria estourar'));
    queue.enqueueLatest('speakers', speakers('ana'));
    queue.enqueueLatest('speakers', speakers('bia'));
    queue.enqueueLatest('speakers', speakers('caio'));
    assert.equal(queue.pending, 1);

    const [frame] = await take(queue, 1);
    assert.deepEqual(frame, speakers('caio'));
    queue.destroy();
  });

  it('o crítico sai antes do volátil, mesmo tendo entrado depois', async () => {
    const queue = new OutboundQueue(100, () => assert.fail('não deveria estourar'));
    queue.enqueueLatest('speakers', speakers('ana'));
    queue.enqueue(response(1));
    queue.enqueue(trackClosed('p1'));

    const frames = await take(queue, 3);
    assert.deepEqual(frames, [response(1), trackClosed('p1'), speakers('ana')]);
    queue.destroy();
  });

  it('com o leitor em dia, nenhum evento volátil se perde', async () => {
    const queue = new OutboundQueue(100, () => assert.fail('não deveria estourar'));
    const recebidos: SignalServerFrame[] = [];
    queue.on('data', (frame: SignalServerFrame) => recebidos.push(frame));

    for (const peerId of ['ana', 'bia', 'caio']) {
      queue.enqueueLatest('speakers', speakers(peerId));
      // Uma volta do event loop: o leitor consome antes do próximo chegar.
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(recebidos, [speakers('ana'), speakers('bia'), speakers('caio')]);
    queue.destroy();
  });

  it('avisa quando a faixa crítica passa do limite, e não aceita mais', () => {
    let estouros = 0;
    const queue = new OutboundQueue(2, () => {
      estouros += 1;
    });
    queue.enqueue(response(1));
    queue.enqueue(response(2));
    assert.equal(estouros, 0);
    queue.enqueue(response(3));
    assert.equal(estouros, 1);
    assert.equal(queue.pending, 2);
    queue.destroy();
  });

  it('ao encerrar, entrega o crítico pendente, descarta o volátil e termina', async () => {
    const queue = new OutboundQueue(100, () => assert.fail('não deveria estourar'));
    queue.enqueue(response(1));
    queue.enqueueLatest('speakers', speakers('ana'));
    queue.finish();
    queue.enqueue(response(2));
    assert.deepEqual(await queue.toArray(), [response(1)]);
  });

  it('cliente lento: o crítico chega inteiro e em ordem, o volátil chega resumido e ATUAL', async () => {
    const queue = new OutboundQueue(1_000, () => assert.fail('não deveria estourar'));
    const escritos: SignalServerFrame[] = [];
    // Um socket que leva 5 ms para aceitar cada quadro.
    const socketLento = new Writable({
      objectMode: true,
      highWaterMark: 1,
      write(chunk: string, _encoding, callback) {
        escritos.push(JSON.parse(chunk) as SignalServerFrame);
        setTimeout(callback, 5);
      },
    });
    const escoando = pipeline(queue, new FrameEncoder(), socketLento);

    // 200 atualizações de quem fala, bem mais rápido do que o socket escoa,
    // com um aviso crítico a cada 20.
    for (let index = 0; index < 200; index += 1) {
      queue.enqueueLatest('speakers', speakers(`par-${index}`));
      if (index % 20 === 0) queue.enqueue(trackClosed(`p${index}`));
      if (index % 10 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    // Espera a fila escoar o que sobrou antes de encerrar: `finish` descarta
    // o volátil pendente, e o que este teste quer ver é o último chegar.
    while (queue.pending > 0) await new Promise((resolve) => setTimeout(resolve, 5));
    queue.finish();
    await escoando;

    const criticos = escritos.filter((frame) => frame.t === 'evt' && frame.e === 'track:closed');
    assert.deepEqual(
      criticos.map((frame) => (frame as SignalEventFrame<'track:closed'>).d.producerId),
      Array.from({ length: 10 }, (_unused, index) => `p${index * 20}`),
    );

    const volateis = escritos.filter((frame) => frame.t === 'evt' && frame.e === 'speakers');
    assert.ok(volateis.length < 200, `nada foi resumido: ${volateis.length} de 200 saíram`);
    assert.deepEqual(volateis.at(-1), speakers('par-199'));
  });
});

describe('sessão — ordem entre resposta e eventos', () => {
  function novaSessao(): SignalSession {
    // A sessão só usa do WebSocket o que corta a conexão; aqui nada corta.
    const ws = { terminate: () => undefined, ping: () => undefined } as unknown as WebSocket;
    const duplex = { setClose: () => undefined } as unknown as WebSocketDuplex;
    return new SignalSession(ws, duplex, 100);
  }

  it('fora de um pedido, o evento sai na hora', async () => {
    const session = novaSessao();
    session.sendEvent('track:closed', trackClosed('p1').d);
    assert.deepEqual(await take(session.outbound, 1), [trackClosed('p1')]);
    session.markClosed();
  });

  it('durante um pedido, o evento espera a resposta — e sai logo atrás dela', async () => {
    const session = novaSessao();
    session.holdEvents();
    session.sendEvent('track:closed', trackClosed('p1').d);
    session.sendLatest('speakers', speakers('ana').d);
    assert.equal(session.outbound.pending, 0);

    session.respond(response(9));
    assert.deepEqual(await take(session.outbound, 3), [response(9), trackClosed('p1'), speakers('ana')]);
    session.markClosed();
  });

  it('depois de pedir o fechamento, nada mais entra e a fila termina', async () => {
    const session = novaSessao();
    session.respond(response(1));
    session.close(4001, 'teste');
    session.sendEvent('track:closed', trackClosed('p1').d);
    session.respond(response(2));
    assert.deepEqual(await session.outbound.toArray(), [response(1)]);
    assert.equal(session.serverCloseCode, 4001);
    session.markClosed();
  });
});
