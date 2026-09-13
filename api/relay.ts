/**
 * Vercel Relay: a função WebSocket que repassa os chunks de tela.
 *
 * ## O que ela faz — e só isso (SPEC §7/§23)
 *
 * Recebe, valida e repassa. NÃO decodifica, redimensiona, recodifica, grava nem
 * guarda um byte de vídeo. O estado da sala vive na memória da instância e some
 * quando a sala esvazia. A lógica de repasse e backpressure é do `RelayRoom`
 * (em `@telecord/shared`, testado em unidade); aqui só ligamos o socket a ele.
 *
 * ## Limitação da Vercel (documentada, não mascarada)
 *
 * Um WebSocket é pinado a UMA instância; a Vercel não garante que streamer e
 * viewers caiam na mesma. Em app de baixo tráfego com uma instância quente,
 * costumam cair juntos e funciona; em escala, precisaria de Redis (que "zero
 * infra" evita). E a conexão CAI no teto de duração da function — o cliente
 * reconecta e pede keyframe. Ver VERCEL-RELAY.md.
 *
 * Exige Fluid Compute (padrão em projetos novos) e o pacote `ws`.
 */
import http from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  decodeControl,
  encodeControl,
  RelayRegistry,
  validateRoomId,
  type RelaySink,
} from '@telecord/shared';

/** Um chunk de tela raramente passa disso; acima é abuso, e recusamos. */
const MAX_MESSAGE_BYTES = 8_000_000;
const CONGESTION_TICK_MS = 2_000;

const registry = new RelayRegistry();
const server = http.createServer();
const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });

// Estimativa de congestão para o streamer, periodicamente — base do adaptive
// bitrate. Vive enquanto a instância viver.
setInterval(() => registry.tickCongestion(), CONGESTION_TICK_MS).unref();

wss.on('connection', (ws: WebSocket, request: http.IncomingMessage) => {
  const url = new URL(request.url ?? '', 'http://localhost');
  const roomId = url.searchParams.get('room') ?? '';
  const role = url.searchParams.get('role');
  const peerId = url.searchParams.get('id') ?? '';

  // Validação de borda: sala válida, papel conhecido, id presente.
  if (validateRoomId(roomId) !== null || peerId === '' || (role !== 'streamer' && role !== 'viewer')) {
    ws.close(1008, 'requisição inválida');
    return;
  }

  const room = registry.getOrCreate(roomId);
  const sink: RelaySink = {
    send: (data) => {
      try {
        ws.send(data);
      } catch {
        // Socket fechando no meio do envio: o `close` abaixo limpa o resto.
      }
    },
    get bufferedAmount(): number {
      return ws.bufferedAmount;
    },
    close: () => ws.close(),
  };

  if (role === 'streamer') {
    // Um streamer por sala (§16): o segundo é recusado, não derruba o primeiro.
    if (room.hasStreamer) {
      ws.close(1008, 'a sala já tem um streamer');
      return;
    }
    room.setStreamer(peerId, sink);
  } else {
    room.addViewer(peerId, sink);
  }

  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      // Viewer NUNCA publica vídeo (§17).
      if (role !== 'streamer') return;
      room.onVideoChunk(toArrayBuffer(data));
      return;
    }
    const message = decodeControl(data.toString());
    if (message === null) return;
    if (message.t === 'ping') {
      sink.send(encodeControl({ t: 'pong' }));
      return;
    }
    if (role === 'streamer') {
      room.onStreamerControl(message);
    } else if (message.t === 'keyframe-request') {
      room.requestKeyframe();
    }
  });

  const leave = (): void => {
    if (role === 'streamer') room.removeStreamer(peerId);
    else room.removeViewer(peerId);
    registry.dropIfEmpty(roomId);
  };
  ws.on('close', leave);
  ws.on('error', leave);
});

/** `ws` entrega binário como `Buffer` (ou lista); copia para um `ArrayBuffer` novo. */
function toArrayBuffer(data: RawData): ArrayBuffer {
  const bytes = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(new Uint8Array(data));
  // Cópia própria: o buffer do `ws` pode ser reusado, e `Buffer` pode estar
  // sobre um `SharedArrayBuffer` — o relay quer um `ArrayBuffer` limpo.
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

export default server;
