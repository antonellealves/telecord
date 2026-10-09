/**
 * O canal de mídia de ponta a ponta, contra um nó de verdade.
 *
 * Tudo aqui passa pelo WebSocket real e pelo Worker real do mediasoup — o
 * que se confere é o contrato que o navegador enxerga: o que cada pedido
 * devolve, em que ORDEM os avisos chegam e com que código a conexão fecha.
 * São as regras que quebram caladas: um `track:closed` que não sai deixa uma
 * tela congelada no palco de alguém, e nenhum erro aparece em lugar nenhum.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SIGNAL_CLOSE, SIGNAL_PROTOCOL_VERSION } from '@telecord/shared';
import type { SfuNode } from '../src/node';
import {
  delay,
  opusParameters,
  RequestFailed,
  SECRET,
  setUpTransports,
  startTestNode,
  TestClient,
  tokenFor,
  until,
  vp8Parameters,
} from './helpers';

let roomSeq = 0;
/** Sala nova por teste: nenhum depende do que o anterior deixou. */
function newRoom(): string {
  roomSeq += 1;
  return `sala-${roomSeq}`;
}

describe('canal de mídia — entrada', () => {
  let node: SfuNode;
  before(async () => {
    node = await startTestNode(43_000);
  });
  after(async () => {
    await node.close();
  });

  it('identifica com token válido e devolve o retrato da sala', async () => {
    const room = newRoom();
    const { client, ready } = await TestClient.join(node.port, room, 'ana');
    assert.equal(ready.peerId, 'ana');
    assert.equal(ready.roomSlug, room);
    assert.equal(ready.protocol, SIGNAL_PROTOCOL_VERSION);
    assert.match(ready.sessionId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(ready.tracks, []);
    assert.deepEqual(ready.transportIds, []);
    assert.ok(Array.isArray((ready.routerRtpCapabilities as { codecs: unknown[] }).codecs));
    assert.deepEqual(node.registry.listPresence(room).map((peer) => peer.peerId), ['ana']);
    await client.leave();
  });

  it('RECUSA token assinado com outro segredo e fecha pedindo token novo', async () => {
    const client = await TestClient.connect(node.port);
    const forged = (await tokenFor('sala-x', 'ana')).replace(/.$/, (last) => (last === '0' ? '1' : '0'));
    await assert.rejects(
      client.request('identify', { token: forged, protocol: SIGNAL_PROTOCOL_VERSION }),
      (error: unknown) => error instanceof RequestFailed && error.code === 'unauthenticated',
    );
    assert.equal((await client.closed).code, SIGNAL_CLOSE.unauthenticated);
  });

  it('RECUSA token vencido', async () => {
    const client = await TestClient.connect(node.port);
    const expired = await tokenFor('sala-x', 'ana', -5_000);
    await assert.rejects(client.request('identify', { token: expired, protocol: SIGNAL_PROTOCOL_VERSION }));
    assert.equal((await client.closed).code, SIGNAL_CLOSE.unauthenticated);
  });

  it('não atende pedido nenhum antes do identify', async () => {
    const client = await TestClient.connect(node.port);
    await assert.rejects(
      client.request('createTransport', { direction: 'send' }),
      (error: unknown) => error instanceof RequestFailed && error.code === 'unauthenticated',
    );
    assert.equal((await client.closed).code, SIGNAL_CLOSE.unauthenticated);
  });

  it('recusa versão de protocolo que não conhece', async () => {
    const client = await TestClient.connect(node.port);
    await assert.rejects(
      client.request('identify', { token: await tokenFor('sala-x', 'ana'), protocol: 999 }),
      (error: unknown) => error instanceof RequestFailed && error.code === 'unsupported',
    );
    assert.equal((await client.closed).code, SIGNAL_CLOSE.protocolError);
  });

  it('fecha com erro de protocolo em quadro que não é JSON, e em quadro binário', async () => {
    const text = await TestClient.connect(node.port);
    text.sendRaw('isto não é json');
    assert.equal((await text.closed).code, SIGNAL_CLOSE.protocolError);

    const binary = await TestClient.connect(node.port);
    binary.sendRaw(Buffer.from([1, 2, 3]));
    assert.equal((await binary.closed).code, SIGNAL_CLOSE.protocolError);
  });

  it('a segunda conexão do mesmo par derruba a primeira, que é proibida de voltar', async () => {
    const room = newRoom();
    const first = await TestClient.join(node.port, room, 'ana');
    const second = await TestClient.join(node.port, room, 'ana');
    assert.equal((await first.client.closed).code, SIGNAL_CLOSE.replaced);
    // A que ficou continua atendendo.
    const pong = await second.client.request('ping', {});
    assert.equal(typeof pong.resumeToken, 'string');
    assert.deepEqual(node.registry.listPresence(room).map((peer) => peer.peerId), ['ana']);
    await second.client.leave();
  });

  it('o token devolvido no ping serve para identificar de novo', async () => {
    const room = newRoom();
    const { client } = await TestClient.join(node.port, room, 'ana');
    const { resumeToken } = await client.request('ping', {});
    await client.drop();

    const again = await TestClient.connect(node.port);
    const ready = await again.request('identify', { token: resumeToken, protocol: SIGNAL_PROTOCOL_VERSION });
    assert.equal(ready.peerId, 'ana');
    assert.equal(ready.roomSlug, room);
    await again.leave();
  });
});

describe('canal de mídia — publicar e assinar', () => {
  let node: SfuNode;
  before(async () => {
    node = await startTestNode(43_300);
  });
  after(async () => {
    await node.close();
  });

  it('quem publica é anunciado aos outros, e quem chega depois recebe no retrato', async () => {
    const room = newRoom();
    const ana = await TestClient.join(node.port, room, 'ana');
    const bia = await TestClient.join(node.port, room, 'bia');
    const anaTransports = await setUpTransports(ana.client, ana.ready);

    const { producerId } = await ana.client.request('produce', {
      transportId: anaTransports.sendId,
      kind: 'audio',
      rtpParameters: opusParameters(),
      trackKind: 'mic',
    });

    const announced = await bia.client.waitEvent('track:announced');
    assert.deepEqual(announced, { roomSlug: room, peerId: 'ana', producerId, kind: 'audio', trackKind: 'mic' });
    // Quem publicou não recebe o próprio anúncio: já tem o id na resposta.
    assert.equal(ana.client.hasEvent('track:announced'), false);

    const caio = await TestClient.join(node.port, room, 'caio');
    assert.deepEqual(caio.ready.tracks, [announced]);

    await Promise.all([ana.client.leave(), bia.client.leave(), caio.client.leave()]);
  });

  it('assina, retoma e pausa uma track de outro par', async () => {
    const room = newRoom();
    const ana = await TestClient.join(node.port, room, 'ana');
    const bia = await TestClient.join(node.port, room, 'bia');
    const anaTransports = await setUpTransports(ana.client, ana.ready);
    const biaTransports = await setUpTransports(bia.client, bia.ready);

    const { producerId } = await ana.client.request('produce', {
      transportId: anaTransports.sendId,
      kind: 'video',
      rtpParameters: vp8Parameters(),
      trackKind: 'screen-video',
    });
    const consumer = await bia.client.request('consume', { transportId: biaTransports.recvId, producerId });
    assert.equal(consumer.producerId, producerId);
    assert.equal(consumer.kind, 'video');
    assert.ok((consumer.rtpParameters as { codecs: unknown[] }).codecs.length > 0);

    await bia.client.request('resumeConsumer', { consumerId: consumer.id });
    await bia.client.request('pauseConsumer', { consumerId: consumer.id });

    await Promise.all([ana.client.leave(), bia.client.leave()]);
  });

  it('parar de publicar tira a track do ar NA HORA para quem assiste', async () => {
    const room = newRoom();
    const ana = await TestClient.join(node.port, room, 'ana');
    const bia = await TestClient.join(node.port, room, 'bia');
    const anaTransports = await setUpTransports(ana.client, ana.ready);
    const biaTransports = await setUpTransports(bia.client, bia.ready);

    const { producerId } = await ana.client.request('produce', {
      transportId: anaTransports.sendId,
      kind: 'video',
      rtpParameters: vp8Parameters(),
      trackKind: 'screen-video',
    });
    await bia.client.request('consume', { transportId: biaTransports.recvId, producerId });

    await ana.client.request('closeProducer', { producerId });
    const closed = await bia.client.waitEvent('track:closed');
    assert.deepEqual(closed, { roomSlug: room, peerId: 'ana', producerId });
    assert.deepEqual(node.registry.publishedTracksInRoom(room), []);
    // O consumer de quem assistia fecha quando o Worker avisa — logo depois.
    await until(() => node.registry.stats().consumers === 0, 2_000, 'o consumer fechar');
    // A origem fechou: `track:closed` conta a história inteira, sem um
    // `consumer:closed` que faria o cliente tentar assinar de novo. O `ping`
    // garante que tudo o que o servidor tinha a dizer já chegou.
    await bia.client.request('ping', {});
    assert.equal(bia.client.hasEvent('consumer:closed'), false);
    // Fechar de novo não é erro — o cliente pode repetir sem medo.
    await ana.client.request('closeProducer', { producerId });

    // E quem chega depois não vê fantasma no retrato.
    const caio = await TestClient.join(node.port, room, 'caio');
    assert.deepEqual(caio.ready.tracks, []);

    await Promise.all([ana.client.leave(), bia.client.leave(), caio.client.leave()]);
  });

  it('publicar de novo o mesmo tipo de track fecha a anterior', async () => {
    const room = newRoom();
    const ana = await TestClient.join(node.port, room, 'ana');
    const bia = await TestClient.join(node.port, room, 'bia');
    const { sendId } = await setUpTransports(ana.client, ana.ready);

    const first = await ana.client.request('produce', {
      transportId: sendId,
      kind: 'audio',
      rtpParameters: opusParameters(),
      trackKind: 'mic',
    });
    const second = await ana.client.request('produce', {
      transportId: sendId,
      kind: 'audio',
      rtpParameters: opusParameters(),
      trackKind: 'mic',
    });

    await bia.client.waitEvent('track:closed', (event) => event.producerId === first.producerId);
    assert.deepEqual(
      node.registry.publishedTracksInRoom(room).map((track) => track.producerId),
      [second.producerId],
    );
    await Promise.all([ana.client.leave(), bia.client.leave()]);
  });

  it('atende uma rajada de pedidos na ordem em que saíram', async () => {
    const room = newRoom();
    const ana = await TestClient.join(node.port, room, 'ana');
    const bia = await TestClient.join(node.port, room, 'bia');
    const anaTransports = await setUpTransports(ana.client, ana.ready);
    const biaTransports = await setUpTransports(bia.client, bia.ready);

    // Vinte tracks publicadas e assinadas em rajada, sem esperar uma pela
    // outra: os pedidos se enfileiram no servidor, que precisa atendê-los na
    // ordem em que saíram.
    const produced = await Promise.all(
      Array.from({ length: 20 }, (_unused, index) =>
        ana.client.request('produce', {
          transportId: anaTransports.sendId,
          kind: 'video',
          rtpParameters: vp8Parameters(),
          // Tipos alternados só para a regra de "um por tipo" não fechar as anteriores.
          trackKind: index % 2 === 0 ? 'camera' : 'screen-video',
        }),
      ),
    );
    // Sobram as duas últimas (uma de cada tipo); as outras dezoito foram fechadas.
    const alive = node.registry.publishedTracksInRoom(room).map((track) => track.producerId);
    assert.deepEqual(alive.sort(), produced.slice(-2).map((entry) => entry.producerId).sort());

    const consumers = await Promise.all(
      alive.map((producerId) => bia.client.request('consume', { transportId: biaTransports.recvId, producerId })),
    );
    assert.equal(consumers.length, 2);
    await Promise.all([ana.client.leave(), bia.client.leave()]);
  });

  it('recusa parâmetro de mídia malformado sem derrubar a conexão', async () => {
    const room = newRoom();
    const ana = await TestClient.join(node.port, room, 'ana');
    const { sendId, recvId } = await setUpTransports(ana.client, ana.ready);

    await assert.rejects(
      ana.client.request('produce', { transportId: sendId, kind: 'audio', rtpParameters: {}, trackKind: 'mic' }),
      (error: unknown) => error instanceof RequestFailed && error.code === 'bad_request',
    );
    await assert.rejects(
      ana.client.request('produce', {
        transportId: recvId,
        kind: 'audio',
        rtpParameters: opusParameters(),
        trackKind: 'mic',
      }),
      (error: unknown) => error instanceof RequestFailed && error.code === 'bad_request',
    );
    await assert.rejects(
      ana.client.request('consume', { transportId: recvId, producerId: 'nao-existe' }),
      (error: unknown) => error instanceof RequestFailed && error.code === 'not_found',
    );
    // Continua de pé.
    assert.equal(typeof (await ana.client.request('ping', {})).now, 'number');
    await ana.client.leave();
  });

  it('renegocia o ICE de um transporte sem trocar de transporte', async () => {
    const room = newRoom();
    const ana = await TestClient.join(node.port, room, 'ana');
    const { sendId } = await setUpTransports(ana.client, ana.ready);
    const { iceParameters } = await ana.client.request('restartIce', { transportId: sendId });
    assert.equal(typeof (iceParameters as { usernameFragment: string }).usernameFragment, 'string');
    await ana.client.leave();
  });
});

describe('canal de mídia — sair, cair e voltar', () => {
  const GRACE_MS = 1_500;
  let node: SfuNode;
  before(async () => {
    // Folga de 1,5 s: curta o bastante para o teste ver a contagem vencer
    // sem esperar dez segundos, longa o bastante para "na hora" e "depois da
    // folga" não se confundirem numa máquina ocupada.
    node = await startTestNode(43_600, { resumeGraceMs: GRACE_MS });
  });
  after(async () => {
    await node.close();
  });

  it('despedida remove o par na hora, sem esperar a folga', async () => {
    const room = newRoom();
    const ana = await TestClient.join(node.port, room, 'ana');
    const bia = await TestClient.join(node.port, room, 'bia');
    const { sendId } = await setUpTransports(ana.client, ana.ready);
    const { producerId } = await ana.client.request('produce', {
      transportId: sendId,
      kind: 'audio',
      rtpParameters: opusParameters(),
      trackKind: 'mic',
    });

    const startedAt = Date.now();
    await ana.client.leave();
    await bia.client.waitEvent('track:closed', (event) => event.producerId === producerId);
    assert.ok(Date.now() - startedAt < GRACE_MS / 2, 'a remoção esperou a folga em vez de ser imediata');
    assert.deepEqual(node.registry.listPresence(room).map((peer) => peer.peerId), ['bia']);
    await bia.client.leave();
  });

  it('queda breve é RETOMADA: mesma sessão, transportes e tracks intactos', async () => {
    const room = newRoom();
    const ana = await TestClient.join(node.port, room, 'ana');
    const bia = await TestClient.join(node.port, room, 'bia');
    const transports = await setUpTransports(ana.client, ana.ready);
    const { producerId } = await ana.client.request('produce', {
      transportId: transports.sendId,
      kind: 'audio',
      rtpParameters: opusParameters(),
      trackKind: 'mic',
    });

    await ana.client.drop();
    await delay(GRACE_MS / 5);
    // Dentro da folga a pessoa continua na sala e a track continua no ar.
    assert.deepEqual(node.registry.listPresence(room).map((peer) => peer.peerId).sort(), ['ana', 'bia']);

    const back = await TestClient.join(node.port, room, 'ana', ana.ready.sessionId);
    assert.equal(back.ready.sessionId, ana.ready.sessionId);
    assert.deepEqual(back.ready.transportIds.sort(), [transports.sendId, transports.recvId].sort());
    assert.deepEqual(back.ready.producerIds, [producerId]);

    // A folga antiga foi cancelada pela volta: passado o prazo, nada some.
    await delay(GRACE_MS * 1.5);
    assert.equal(bia.client.hasEvent('track:closed'), false);
    assert.equal(node.registry.publishedTracksInRoom(room).length, 1);
    await Promise.all([back.client.leave(), bia.client.leave()]);
  });

  it('quem não volta dentro da folga é removido, e a sala fica sabendo', async () => {
    const room = newRoom();
    const ana = await TestClient.join(node.port, room, 'ana');
    const bia = await TestClient.join(node.port, room, 'bia');
    const { sendId } = await setUpTransports(ana.client, ana.ready);
    const { producerId } = await ana.client.request('produce', {
      transportId: sendId,
      kind: 'audio',
      rtpParameters: opusParameters(),
      trackKind: 'mic',
    });

    await ana.client.drop();
    await bia.client.waitEvent('track:closed', (event) => event.producerId === producerId, GRACE_MS * 4);
    assert.deepEqual(node.registry.listPresence(room).map((peer) => peer.peerId), ['bia']);

    // Voltar DEPOIS é sessão nova: o id antigo não vale mais nada.
    const back = await TestClient.join(node.port, room, 'ana', ana.ready.sessionId);
    assert.notEqual(back.ready.sessionId, ana.ready.sessionId);
    assert.deepEqual(back.ready.transportIds, []);
    await Promise.all([back.client.leave(), bia.client.leave()]);
  });

  it('recarregar a página (identify sem sessão) descarta a mídia da página anterior', async () => {
    const room = newRoom();
    const ana = await TestClient.join(node.port, room, 'ana');
    const bia = await TestClient.join(node.port, room, 'bia');
    const { sendId } = await setUpTransports(ana.client, ana.ready);
    const { producerId } = await ana.client.request('produce', {
      transportId: sendId,
      kind: 'video',
      rtpParameters: vp8Parameters(),
      trackKind: 'screen-video',
    });

    await ana.client.drop();
    const reloaded = await TestClient.join(node.port, room, 'ana');
    assert.notEqual(reloaded.ready.sessionId, ana.ready.sessionId);
    assert.deepEqual(reloaded.ready.producerIds, []);
    // A tela da página antiga sai do palco de quem assistia — não fica um
    // fantasma compartilhando ao lado do que a página nova publicar.
    await bia.client.waitEvent('track:closed', (event) => event.producerId === producerId);
    await Promise.all([reloaded.client.leave(), bia.client.leave()]);
  });

  it('expulso pela moderação é fechado com o código que proíbe reconectar', async () => {
    const room = newRoom();
    const ana = await TestClient.join(node.port, room, 'ana');
    const response = await fetch(`http://127.0.0.1:${node.port}/rooms/${room}/leave`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId: 'ana', kicked: true }),
    });
    assert.equal(response.status, 200);
    assert.equal((await ana.client.closed).code, SIGNAL_CLOSE.removed);
    assert.deepEqual(node.registry.listPresence(room), []);
  });

  it('sala vazia não deixa Router nem sala para trás', async () => {
    const room = newRoom();
    const ana = await TestClient.join(node.port, room, 'ana');
    await setUpTransports(ana.client, ana.ready);
    const before = node.registry.stats().rooms;
    await ana.client.leave();
    await until(() => node.registry.stats().rooms === before - 1, 2_000, 'a sala fechar');
    // E a conta de carga do Worker volta a zero: nada ficou pesando.
    await until(() => node.pool.slots[0]!.units === 0, 2_000, 'a carga do Worker zerar');
  });
});

describe('canal de mídia — batimento', () => {
  let node: SfuNode;
  before(async () => {
    node = await startTestNode(43_900, { heartbeatIntervalMs: 250, resumeGraceMs: 300 });
  });
  after(async () => {
    await node.close();
  });

  it('derruba quem deixou de responder ao ping, e mantém quem responde', async () => {
    const room = newRoom();
    const alive = await TestClient.join(node.port, room, 'viva');

    const dead = await TestClient.connect(node.port, { autoPong: false });
    await dead.request('identify', { token: await tokenFor(room, 'muda'), protocol: SIGNAL_PROTOCOL_VERSION });
    // Sem código: para quem não responde não há quadro de fechamento que chegue.
    assert.equal((await dead.closed).code, 1006);

    await until(() => node.registry.listPresence(room).length === 1, 5_000, 'a presença de quem caiu expirar');
    assert.equal(typeof (await alive.client.request('ping', {})).now, 'number');
    await alive.client.leave();
  });
});
