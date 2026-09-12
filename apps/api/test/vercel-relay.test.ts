/**
 * O núcleo do Vercel Relay: protocolo binário, detecção de perda por sequência
 * e a sala de relay com backpressure. Tudo puro — roda sem rede, sem `ws` e sem
 * navegador (a conexão entra por `RelaySink`, um dublê aqui).
 *
 * O fluxo ponta-a-ponta (getDisplayMedia + WebCodecs + WebSocket ao vivo) exige
 * dois navegadores e fica para a validação manual; o que dá para provar em
 * unidade — que é onde os bugs de protocolo e de backpressure moram — está aqui.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decodeControl,
  decodeVideoChunk,
  encodeControl,
  encodeVideoChunk,
  peekHeader,
  RelayRegistry,
  RelayRoom,
  SequenceTracker,
  type RelaySink,
  type StreamControlMessage,
} from '@telecord/shared';

describe('protocolo binário de vídeo', () => {
  it('ida e volta preserva sequência, timestamp, keyframe e payload', () => {
    const data = new Uint8Array([10, 20, 30, 40, 250]);
    const buffer = encodeVideoChunk({ sequenceNumber: 42, timestamp: 1_000_000, keyframe: true, data });
    const back = decodeVideoChunk(buffer);
    assert.notEqual(back, null);
    assert.equal(back?.sequenceNumber, 42);
    assert.equal(back?.timestamp, 1_000_000);
    assert.equal(back?.keyframe, true);
    assert.deepEqual(Array.from(back?.data ?? []), Array.from(data));
  });

  it('peekHeader lê o cabeçalho sem tocar no payload', () => {
    const buffer = encodeVideoChunk({ sequenceNumber: 7, timestamp: 5, keyframe: false, data: new Uint8Array([1]) });
    const header = peekHeader(buffer);
    assert.equal(header?.sequenceNumber, 7);
    assert.equal(header?.keyframe, false);
  });

  it('recusa buffer curto ou de versão errada', () => {
    assert.equal(decodeVideoChunk(new ArrayBuffer(4)), null);
    const bad = new ArrayBuffer(16);
    new DataView(bad).setUint8(0, 99); // versão inexistente
    assert.equal(decodeVideoChunk(bad), null);
    assert.equal(peekHeader(bad), null);
  });
});

describe('protocolo de controle (JSON)', () => {
  it('ida e volta de cada tipo de mensagem', () => {
    const messages: StreamControlMessage[] = [
      { t: 'init', codec: 'vp09.00.10.08', width: 1920, height: 1080, fps: 30, bitrate: 4_000_000 },
      { t: 'keyframe-request' },
      { t: 'viewers', count: 3 },
      { t: 'end' },
      { t: 'ping' },
      { t: 'pong' },
      { t: 'congestion', maxBufferedBytes: 123, viewers: 2, dropped: 4 },
    ];
    for (const message of messages) {
      assert.deepEqual(decodeControl(encodeControl(message)), message);
    }
  });

  it('recusa JSON inválido ou tipo desconhecido', () => {
    assert.equal(decodeControl('não é json'), null);
    assert.equal(decodeControl('{"t":"desconhecido"}'), null);
    assert.equal(decodeControl('{"t":"init"}'), null); // faltam campos
  });
});

describe('SequenceTracker', () => {
  it('em ordem, tudo decodifica', () => {
    const tracker = new SequenceTracker();
    assert.deepEqual(tracker.receive(1, true), { decode: true, requestKeyframe: false });
    assert.deepEqual(tracker.receive(2, false), { decode: true, requestKeyframe: false });
    assert.deepEqual(tracker.receive(3, false), { decode: true, requestKeyframe: false });
  });

  it('buraco descarta órfãos e pede keyframe até um chegar', () => {
    const tracker = new SequenceTracker();
    tracker.receive(1, true);
    tracker.receive(2, false);
    // faltou o 3: o 4 vira buraco
    assert.deepEqual(tracker.receive(4, false), { decode: false, requestKeyframe: true });
    // deltas seguintes ficam órfãos, sem pedir de novo
    assert.deepEqual(tracker.receive(5, false), { decode: false, requestKeyframe: false });
    // keyframe reancora
    assert.deepEqual(tracker.receive(6, true), { decode: true, requestKeyframe: false });
    assert.deepEqual(tracker.receive(7, false), { decode: true, requestKeyframe: false });
  });

  it('começar num delta pede keyframe', () => {
    const tracker = new SequenceTracker();
    assert.deepEqual(tracker.receive(100, false), { decode: false, requestKeyframe: true });
  });

  it('atrasado/repetido é descartado sem alarme', () => {
    const tracker = new SequenceTracker();
    tracker.receive(10, true);
    tracker.receive(11, false);
    assert.deepEqual(tracker.receive(10, false), { decode: false, requestKeyframe: false });
  });
});

/** Dublê de conexão: guarda o que foi enviado e deixa o teste mexer no backlog. */
class FakeSink implements RelaySink {
  readonly sent: (ArrayBuffer | string)[] = [];
  bufferedAmount = 0;
  closed = false;
  send(data: ArrayBuffer | string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  controls(): StreamControlMessage[] {
    const out: StreamControlMessage[] = [];
    for (const item of this.sent) {
      if (typeof item === 'string') {
        const parsed = decodeControl(item);
        if (parsed !== null) out.push(parsed);
      }
    }
    return out;
  }
  binaryCount(): number {
    return this.sent.filter((item) => typeof item !== 'string').length;
  }
}

function keyframe(seq: number): ArrayBuffer {
  return encodeVideoChunk({ sequenceNumber: seq, timestamp: seq, keyframe: true, data: new Uint8Array([1]) });
}
function delta(seq: number): ArrayBuffer {
  return encodeVideoChunk({ sequenceNumber: seq, timestamp: seq, keyframe: false, data: new Uint8Array([2]) });
}

describe('RelayRoom', () => {
  it('repassa o keyframe a todos os viewers', () => {
    const room = new RelayRoom('sala');
    const streamer = new FakeSink();
    const v1 = new FakeSink();
    const v2 = new FakeSink();
    room.setStreamer('s', streamer);
    room.addViewer('v1', v1);
    room.addViewer('v2', v2);

    room.onVideoChunk(keyframe(1));
    assert.equal(v1.binaryCount(), 1);
    assert.equal(v2.binaryCount(), 1);
  });

  it('viewer que entra dispara pedido de keyframe ao streamer e recebe o init guardado', () => {
    const room = new RelayRoom('sala');
    const streamer = new FakeSink();
    room.setStreamer('s', streamer);
    room.onStreamerControl({ t: 'init', codec: 'vp09.00.10.08', width: 1280, height: 720, fps: 30, bitrate: 3_000_000 });

    const viewer = new FakeSink();
    room.addViewer('v', viewer);

    assert.ok(streamer.controls().some((m) => m.t === 'keyframe-request'));
    assert.ok(viewer.controls().some((m) => m.t === 'init'));
  });

  it('backpressure: viewer lento perde deltas, o rápido não; keyframe ainda passa', () => {
    const room = new RelayRoom('sala');
    room.setStreamer('s', new FakeSink());
    const rapido = new FakeSink();
    const lento = new FakeSink();
    room.addViewer('rapido', rapido);
    room.addViewer('lento', lento);

    // keyframe inicial: os dois recebem e saem do estado "precisa keyframe"
    room.onVideoChunk(keyframe(1));
    const rapidoBase = rapido.binaryCount();
    const lentoBase = lento.binaryCount();

    // o lento entope; o rápido não
    lento.bufferedAmount = 5_000_000; // acima do limite mole
    room.onVideoChunk(delta(2));

    assert.equal(rapido.binaryCount(), rapidoBase + 1, 'o rápido recebe o delta');
    assert.equal(lento.binaryCount(), lentoBase, 'o lento não recebe o delta');

    // enquanto entupido, o lento fica esperando keyframe: nem o próximo delta vai
    room.onVideoChunk(delta(3));
    assert.equal(lento.binaryCount(), lentoBase);

    // um keyframe (com o backlog ainda alto, mas abaixo do limite duro) reancora
    lento.bufferedAmount = 3_000_000;
    room.onVideoChunk(keyframe(4));
    assert.equal(lento.binaryCount(), lentoBase + 1, 'o keyframe passa e recupera o lento');
  });

  it('sair e fechar limpam o estado', () => {
    const room = new RelayRoom('sala');
    const streamer = new FakeSink();
    const viewer = new FakeSink();
    room.setStreamer('s', streamer);
    room.addViewer('v', viewer);
    assert.equal(room.viewerCount, 1);

    room.removeViewer('v');
    assert.equal(room.viewerCount, 0);

    room.close();
    assert.equal(streamer.closed, true);
    assert.equal(room.isEmpty, true);
  });
});

describe('RelayRegistry', () => {
  it('cria sob demanda e descarta quando vazia', () => {
    const registry = new RelayRegistry();
    const room = registry.getOrCreate('x');
    assert.equal(registry.size, 1);
    assert.equal(registry.getOrCreate('x'), room, 'reusa a mesma sala');

    registry.dropIfEmpty('x');
    assert.equal(registry.size, 0, 'sala vazia é liberada');
  });

  it('não descarta sala com gente dentro', () => {
    const registry = new RelayRegistry();
    const room = registry.getOrCreate('x');
    room.setStreamer('s', new FakeSink());
    registry.dropIfEmpty('x');
    assert.equal(registry.size, 1);
  });
});
