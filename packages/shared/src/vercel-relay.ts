/**
 * Protocolo do Vercel Relay: como um quadro de vídeo vira bytes na rede.
 *
 * ## Dois canais no mesmo WebSocket
 *
 * O WebSocket carrega DOIS tipos de frame nativamente: binário e texto. Este
 * protocolo usa os dois de propósito:
 *
 *  - **Binário** para o caminho quente — cada `EncodedVideoChunk`. Um cabeçalho
 *    fixo de 16 bytes + o payload cru do codec. Nada de JSON por quadro, nada de
 *    base64: os bytes do VP9/H264 vão inteiros.
 *  - **Texto (JSON)** para o controle — `init`, pedido de keyframe, entra/sai de
 *    viewer, fim. São raros (não por quadro), então a legibilidade do JSON
 *    compensa, e um `type` discriminado dá tipos concretos sem `any`.
 *
 * ## O cabeçalho binário (16 bytes, little-endian)
 *
 * ```
 * offset 0  u8   version           (protocolo; hoje 1)
 * offset 1  u8   flags             (bit 0: 1 = keyframe)
 * offset 2  u16  reserved          (alinhamento; zero)
 * offset 4  u32  sequenceNumber    (detecta perda: 100,101,102,104 → faltou 103)
 * offset 8  f64  timestamp (µs)    (o mesmo do EncodedVideoChunk)
 * offset 16 …    payload           (bytes do chunk, sem cópia extra)
 * ```
 */

export const PROTOCOL_VERSION = 1;
export const HEADER_BYTES = 16;

const FLAG_KEYFRAME = 0b0000_0001;

/**
 * Um quadro de vídeo em forma neutra — sem depender de `EncodedVideoChunk`, que
 * é DOM. É o que torna este arquivo puro e testável em Node: a conversão de/para
 * `EncodedVideoChunk` mora no encoder e no decoder, não aqui.
 */
export interface VideoChunkFrame {
  sequenceNumber: number;
  /** Microssegundos, como o `timestamp` do `EncodedVideoChunk`. */
  timestamp: number;
  keyframe: boolean;
  data: Uint8Array;
}

/** Serializa um quadro para um `ArrayBuffer` pronto para `ws.send`. */
export function encodeVideoChunk(frame: VideoChunkFrame): ArrayBuffer {
  const buffer = new ArrayBuffer(HEADER_BYTES + frame.data.byteLength);
  const view = new DataView(buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, frame.keyframe ? FLAG_KEYFRAME : 0);
  view.setUint16(2, 0, true);
  view.setUint32(4, frame.sequenceNumber >>> 0, true);
  view.setFloat64(8, frame.timestamp, true);
  new Uint8Array(buffer, HEADER_BYTES).set(frame.data);
  return buffer;
}

/**
 * Lê um quadro de um buffer recebido. `null` se o buffer for curto demais ou de
 * outra versão — o relay e o viewer descartam em vez de estourar.
 */
export function decodeVideoChunk(buffer: ArrayBuffer): VideoChunkFrame | null {
  if (buffer.byteLength < HEADER_BYTES) return null;
  const view = new DataView(buffer);
  if (view.getUint8(0) !== PROTOCOL_VERSION) return null;
  const flags = view.getUint8(1);
  return {
    keyframe: (flags & FLAG_KEYFRAME) !== 0,
    sequenceNumber: view.getUint32(4, true),
    timestamp: view.getFloat64(8, true),
    // Cópia (slice) para o payload sobreviver ao reuso do buffer da rede.
    data: new Uint8Array(buffer.slice(HEADER_BYTES)),
  };
}

/** Só o cabeçalho, sem copiar o payload — o relay decide sem tocar nos bytes. */
export interface ChunkHeader {
  version: number;
  keyframe: boolean;
  sequenceNumber: number;
  timestamp: number;
}

export function peekHeader(buffer: ArrayBuffer): ChunkHeader | null {
  if (buffer.byteLength < HEADER_BYTES) return null;
  const view = new DataView(buffer);
  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) return null;
  return {
    version,
    keyframe: (view.getUint8(1) & FLAG_KEYFRAME) !== 0,
    sequenceNumber: view.getUint32(4, true),
    timestamp: view.getFloat64(8, true),
  };
}

// ---------------------------------------------------------------------------
// Controle: mensagens JSON (texto), raras, com `type` discriminado
// ---------------------------------------------------------------------------

/** Papel na sala: quem publica e quem só assiste. */
export type StreamRole = 'streamer' | 'viewer';

/** Configuração que o viewer precisa para montar o `VideoDecoder`. */
export interface StreamInit {
  t: 'init';
  codec: string;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  /** `description` do `VideoDecoderConfig` (H264/AVC precisa; VP9 não), base64. */
  description?: string;
}

export interface StreamKeyframeRequest {
  t: 'keyframe-request';
  /** Quem pediu, para diagnóstico; o streamer só precisa saber que pediram. */
  viewerId?: string;
}

export interface StreamViewers {
  t: 'viewers';
  count: number;
}

export interface StreamEnd {
  t: 'end';
}

export interface StreamPing {
  t: 'ping';
}

export interface StreamPong {
  t: 'pong';
}

/** Estimativa agregada que o relay devolve ao streamer, base do adaptive bitrate. */
export interface StreamCongestion {
  t: 'congestion';
  /** Pior backlog entre os viewers, em bytes. */
  maxBufferedBytes: number;
  viewers: number;
  /** Quantos chunks o relay descartou de viewers lentos desde o último aviso. */
  dropped: number;
}

export type StreamControlMessage =
  | StreamInit
  | StreamKeyframeRequest
  | StreamViewers
  | StreamEnd
  | StreamPing
  | StreamPong
  | StreamCongestion;

/** Serializa uma mensagem de controle para um frame de texto. */
export function encodeControl(message: StreamControlMessage): string {
  return JSON.stringify(message);
}

/**
 * Lê uma mensagem de controle. `null` para lixo — entrada da rede é sempre
 * não confiável, mesmo vindo do relay.
 */
export function decodeControl(raw: string): StreamControlMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const value = parsed as { t?: unknown };
  switch (value.t) {
    case 'init':
      return isInit(parsed) ? parsed : null;
    case 'keyframe-request': {
      // Só inclui `viewerId` quando veio — um `viewerId: undefined` a mais
      // quebraria uma comparação estrita de igualdade sem significar nada.
      const viewerId = readOptionalString(parsed, 'viewerId');
      return viewerId === undefined ? { t: 'keyframe-request' } : { t: 'keyframe-request', viewerId };
    }
    case 'viewers':
      return isViewers(parsed) ? parsed : null;
    case 'end':
      return { t: 'end' };
    case 'ping':
      return { t: 'ping' };
    case 'pong':
      return { t: 'pong' };
    case 'congestion':
      return isCongestion(parsed) ? parsed : null;
    default:
      return null;
  }
}

function num(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readOptionalString(source: unknown, key: string): string | undefined {
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function isInit(value: unknown): value is StreamInit {
  const v = value as Partial<StreamInit>;
  return (
    typeof v.codec === 'string' &&
    num(v.width) &&
    num(v.height) &&
    num(v.fps) &&
    num(v.bitrate)
  );
}

function isViewers(value: unknown): value is StreamViewers {
  return num((value as Partial<StreamViewers>).count);
}

function isCongestion(value: unknown): value is StreamCongestion {
  const v = value as Partial<StreamCongestion>;
  return num(v.maxBufferedBytes) && num(v.viewers) && num(v.dropped);
}

// ---------------------------------------------------------------------------
// Detecção de perda por sequência (lado de quem assiste)
// ---------------------------------------------------------------------------

export interface FrameDecision {
  /** Entregar este quadro ao decoder? */
  decode: boolean;
  /** Pedir um keyframe agora? (perda detectada, ou começou no meio.) */
  requestKeyframe: boolean;
}

/**
 * Um `VideoDecoder` só decodifica um delta se tiver o quadro anterior. Se um
 * delta se perde (100, 101, 102, **104** → faltou o 103), os deltas seguintes
 * ficam órfãos e a imagem congela. A saída não é esperar para sempre: é
 * DESCARTAR os órfãos e pedir um keyframe, que reinicia a cadeia.
 */
export class SequenceTracker {
  private expected: number | null = null;
  private waiting = false;

  receive(sequenceNumber: number, keyframe: boolean): FrameDecision {
    if (keyframe) {
      this.expected = sequenceNumber + 1;
      this.waiting = false;
      return { decode: true, requestKeyframe: false };
    }
    if (this.waiting) {
      return { decode: false, requestKeyframe: false };
    }
    if (this.expected === null) {
      // Delta como primeiro quadro visto: entrou no meio, sem referência.
      this.waiting = true;
      return { decode: false, requestKeyframe: true };
    }
    if (sequenceNumber === this.expected) {
      this.expected = sequenceNumber + 1;
      return { decode: true, requestKeyframe: false };
    }
    if (sequenceNumber < this.expected) {
      // Atrasado ou repetido: já passou, descarta sem alarme.
      return { decode: false, requestKeyframe: false };
    }
    // Buraco: à frente do esperado, faltou algo. Espera e pede keyframe.
    this.waiting = true;
    return { decode: false, requestKeyframe: true };
  }

  reset(): void {
    this.expected = null;
    this.waiting = false;
  }
}

// ---------------------------------------------------------------------------
// Sala do relay (lado do servidor) — pura, testável, sem `ws`
// ---------------------------------------------------------------------------

/** A conexão de um par, abstraída para a sala ser testável sem o socket real. */
export interface RelaySink {
  send(data: ArrayBuffer | string): void;
  readonly bufferedAmount: number;
  close(): void;
}

/** Acima disto, param os deltas do viewer (ele está atrasando). */
const SOFT_LIMIT_BYTES = 2_000_000;
/** Acima disto, nem keyframe entra até drenar (viewer catastroficamente atrás). */
const HARD_LIMIT_BYTES = 8_000_000;

interface Viewer {
  id: string;
  sink: RelaySink;
  needsKeyframe: boolean;
  droppedSinceKeyframe: number;
}

/**
 * Repassa os chunks do streamer aos viewers SEM decodificar, redimensionar,
 * recodificar ou guardar. Um streamer, vários viewers, estado só em memória.
 *
 * Backpressure é o ponto crítico: um viewer lento não pode derrubar os outros
 * nem estourar a memória. Cada envio olha o `bufferedAmount` da conexão dele —
 * passou do limite mole, os deltas param e pede-se keyframe; passou do duro, nem
 * keyframe entra até drenar. Keyframe tem prioridade: é o único quadro que
 * reinicia a decodificação.
 */
export class RelayRoom {
  readonly id: string;
  readonly createdAt = Date.now();
  lastSequenceNumber = 0;

  private streamer: { id: string; sink: RelaySink } | null = null;
  private readonly viewers = new Map<string, Viewer>();
  private lastInit: StreamInit | null = null;
  private keyframeRequested = false;
  private droppedSinceReport = 0;

  constructor(id: string) {
    this.id = id;
  }

  get viewerCount(): number {
    return this.viewers.size;
  }
  get hasStreamer(): boolean {
    return this.streamer !== null;
  }
  get isEmpty(): boolean {
    return this.streamer === null && this.viewers.size === 0;
  }

  setStreamer(id: string, sink: RelaySink): void {
    this.streamer = { id, sink };
    this.keyframeRequested = false;
    for (const viewer of this.viewers.values()) viewer.needsKeyframe = true;
    this.announceViewers();
  }

  removeStreamer(id: string): void {
    if (this.streamer?.id !== id) return;
    this.streamer = null;
    this.lastInit = null;
    this.broadcastControl({ t: 'end' });
  }

  addViewer(id: string, sink: RelaySink): void {
    this.viewers.set(id, { id, sink, needsKeyframe: true, droppedSinceKeyframe: 0 });
    if (this.lastInit !== null) sink.send(encodeControl(this.lastInit));
    this.requestKeyframe();
    this.announceViewers();
  }

  removeViewer(id: string): void {
    if (this.viewers.delete(id)) this.announceViewers();
  }

  onVideoChunk(buffer: ArrayBuffer): void {
    const header = peekHeader(buffer);
    if (header === null) return;
    this.lastSequenceNumber = header.sequenceNumber;
    if (header.keyframe) this.keyframeRequested = false;
    for (const viewer of this.viewers.values()) {
      this.sendChunkToViewer(viewer, buffer, header.keyframe);
    }
  }

  onStreamerControl(message: StreamControlMessage): void {
    if (message.t === 'init') {
      this.lastInit = message;
      this.broadcastControl(message);
      return;
    }
    if (message.t === 'end') {
      this.broadcastControl(message);
      this.lastInit = null;
    }
  }

  requestKeyframe(): void {
    if (this.streamer === null || this.keyframeRequested) return;
    this.keyframeRequested = true;
    this.streamer.sink.send(encodeControl({ t: 'keyframe-request' }));
  }

  reportCongestion(): void {
    if (this.streamer === null) return;
    let maxBuffered = 0;
    for (const viewer of this.viewers.values()) {
      if (viewer.sink.bufferedAmount > maxBuffered) maxBuffered = viewer.sink.bufferedAmount;
    }
    this.streamer.sink.send(
      encodeControl({
        t: 'congestion',
        maxBufferedBytes: maxBuffered,
        viewers: this.viewers.size,
        dropped: this.droppedSinceReport,
      }),
    );
    this.droppedSinceReport = 0;
  }

  close(): void {
    this.streamer?.sink.close();
    for (const viewer of this.viewers.values()) viewer.sink.close();
    this.viewers.clear();
    this.streamer = null;
    this.lastInit = null;
  }

  private sendChunkToViewer(viewer: Viewer, buffer: ArrayBuffer, keyframe: boolean): void {
    const buffered = viewer.sink.bufferedAmount;
    if (keyframe) {
      if (buffered > HARD_LIMIT_BYTES) {
        viewer.needsKeyframe = true;
        viewer.droppedSinceKeyframe += 1;
        this.droppedSinceReport += 1;
        return;
      }
      viewer.needsKeyframe = false;
      viewer.droppedSinceKeyframe = 0;
      viewer.sink.send(buffer);
      return;
    }
    if (viewer.needsKeyframe) return;
    if (buffered > SOFT_LIMIT_BYTES) {
      viewer.needsKeyframe = true;
      viewer.droppedSinceKeyframe += 1;
      this.droppedSinceReport += 1;
      this.requestKeyframe();
      return;
    }
    viewer.sink.send(buffer);
  }

  private broadcastControl(message: StreamControlMessage): void {
    const raw = encodeControl(message);
    for (const viewer of this.viewers.values()) viewer.sink.send(raw);
  }

  private announceViewers(): void {
    if (this.streamer === null) return;
    this.streamer.sink.send(encodeControl({ t: 'viewers', count: this.viewers.size }));
  }
}

/**
 * Salas vivas nesta instância — efêmero, só memória.
 *
 * LIMITAÇÃO (Vercel, documentada): este mapa vale para UMA instância. A Vercel
 * não garante que streamer e viewers caiam na mesma; num app de baixo tráfego
 * com uma instância quente, costumam cair juntos, mas não é garantia. Escala
 * pediria Redis — o que "zero infra" evita. Ver VERCEL-RELAY.md.
 */
export class RelayRegistry {
  private readonly rooms = new Map<string, RelayRoom>();

  get(id: string): RelayRoom | undefined {
    return this.rooms.get(id);
  }

  getOrCreate(id: string): RelayRoom {
    let room = this.rooms.get(id);
    if (room === undefined) {
      room = new RelayRoom(id);
      this.rooms.set(id, room);
    }
    return room;
  }

  dropIfEmpty(id: string): void {
    const room = this.rooms.get(id);
    if (room !== undefined && room.isEmpty) {
      room.close();
      this.rooms.delete(id);
    }
  }

  /** Passa em todas as salas mandando a estimativa de congestão ao streamer. */
  tickCongestion(): void {
    for (const room of this.rooms.values()) room.reportCongestion();
  }

  get size(): number {
    return this.rooms.size;
  }
}

// ---------------------------------------------------------------------------
// Adaptive bitrate (política simples: GOOD sobe, DEGRADED segura, BAD desce)
// ---------------------------------------------------------------------------

export type CongestionState = 'GOOD' | 'DEGRADED' | 'BAD';

/**
 * Classifica a rede pelo pior backlog entre os viewers e pelo que o relay
 * descartou. Descartou = alguém já não acompanha → BAD, sem meio-termo.
 */
export function classifyCongestion(maxBufferedBytes: number, dropped: number): CongestionState {
  if (dropped > 0 || maxBufferedBytes > 3_000_000) return 'BAD';
  if (maxBufferedBytes > 1_000_000) return 'DEGRADED';
  return 'GOOD';
}

/**
 * Próximo teto de bitrate. BAD corta 30%; DEGRADED segura; GOOD sobe 10% —
 * devagar na subida, rápido na descida, que é o certo para não oscilar.
 * Preso à faixa da resolução (§4).
 */
export function nextBitrate(
  current: number,
  state: CongestionState,
  min: number,
  max: number,
): number {
  if (state === 'BAD') return Math.max(min, Math.round(current * 0.7));
  if (state === 'DEGRADED') return current;
  return Math.min(max, Math.round(current * 1.1));
}
