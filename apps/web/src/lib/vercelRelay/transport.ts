/**
 * Abstração de transporte do stream de tela — o resto do app não conhece o
 * WebSocket. SPEC §6/§19: hoje a implementação é `VercelWebSocketTransport`, e
 * um `MediasoupTransport`/`P2PTransport` entra depois sem tocar na UI.
 */
import {
  decodeControl,
  decodeVideoChunk,
  encodeControl,
  encodeVideoChunk,
  type StreamControlMessage,
  type VideoChunkFrame,
} from '@telecord/shared';

export type ChunkHandler = (frame: VideoChunkFrame) => void;
export type ControlHandler = (message: StreamControlMessage) => void;
export type OpenHandler = (open: boolean) => void;

export interface ScreenStreamTransport {
  connect(): void;
  /** Resolve quando o socket abre pela primeira vez — publicar antes disso se perde. */
  waitUntilOpen(): Promise<void>;
  publishChunk(frame: VideoChunkFrame): void;
  sendControl(message: StreamControlMessage): void;
  requestKeyframe(): void;
  onChunk(handler: ChunkHandler): () => void;
  onControl(handler: ControlHandler): () => void;
  onOpen(handler: OpenHandler): () => void;
  readonly bufferedAmount: number;
  disconnect(): void;
}

export type StreamRole = 'streamer' | 'viewer';

interface Options {
  roomId: string;
  peerId: string;
  role: StreamRole;
}

const HEARTBEAT_MS = 15_000;
const MAX_BACKOFF_MS = 15_000;

/**
 * Transporte sobre um WebSocket para a função de relay da Vercel.
 *
 * Reconecta com backoff (a conexão cai no teto de duração da function — ver
 * VERCEL-RELAY.md) e faz ping/pong para segurar a conexão viva. Ao reconectar,
 * o viewer pede keyframe sozinho pelo `SequenceTracker`, então aqui basta subir
 * de novo e reassinar.
 */
export class VercelWebSocketTransport implements ScreenStreamTransport {
  private ws: WebSocket | null = null;
  private backoff = 1_000;
  private heartbeat = 0;
  private alive = false;
  private readonly chunkHandlers = new Set<ChunkHandler>();
  private readonly controlHandlers = new Set<ControlHandler>();
  private readonly openHandlers = new Set<OpenHandler>();
  private openPromise: Promise<void> | null = null;
  private resolveOpen: (() => void) | null = null;

  constructor(private readonly options: Options) {}

  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  connect(): void {
    this.alive = true;
    this.openPromise = new Promise((resolve) => {
      this.resolveOpen = resolve;
    });
    this.open();
  }

  /**
   * Resolve na primeira vez que o socket abrir. Quem publica (streamer, mic)
   * precisa esperar isto ANTES do primeiro `sendControl`/`publishChunk` —
   * mandar antes do `open` é descartado em silêncio pelo `readyState` guard,
   * e o `init` perdido é o que deixa o viewer sem vídeo nenhum.
   */
  waitUntilOpen(): Promise<void> {
    return this.openPromise ?? Promise.resolve();
  }

  private open(): void {
    if (!this.alive) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams({
      room: this.options.roomId,
      role: this.options.role,
      id: this.options.peerId,
    });
    const ws = new WebSocket(`${proto}//${window.location.host}/api/relay?${params.toString()}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.backoff = 1_000;
      this.resolveOpen?.();
      this.resolveOpen = null;
      for (const handler of this.openHandlers) handler(true);
      this.heartbeat = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(encodeControl({ t: 'ping' }));
      }, HEARTBEAT_MS);
    });

    ws.addEventListener('message', (event) => this.handleMessage(event.data));

    ws.addEventListener('close', () => {
      window.clearInterval(this.heartbeat);
      for (const handler of this.openHandlers) handler(false);
      if (!this.alive) return;
      // Reconecta com backoff — a queda por duração máxima é esperada. Nova
      // promessa: quem já esperou a primeira abertura não precisa esperar de
      // novo, mas o próximo reconnect tem a sua própria.
      this.openPromise = new Promise((resolve) => {
        this.resolveOpen = resolve;
      });
      window.setTimeout(() => this.open(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    });

    ws.addEventListener('error', () => ws.close());
  }

  private handleMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      const frame = decodeVideoChunk(data);
      if (frame !== null) {
        for (const handler of this.chunkHandlers) handler(frame);
      }
      return;
    }
    if (typeof data === 'string') {
      const message = decodeControl(data);
      if (message === null) return;
      if (message.t === 'ping') {
        this.ws?.send(encodeControl({ t: 'pong' }));
        return;
      }
      if (message.t === 'pong') return;
      for (const handler of this.controlHandlers) handler(message);
    }
  }

  publishChunk(frame: VideoChunkFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeVideoChunk(frame));
    }
  }

  sendControl(message: StreamControlMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeControl(message));
    }
  }

  requestKeyframe(): void {
    this.sendControl({ t: 'keyframe-request' });
  }

  onChunk(handler: ChunkHandler): () => void {
    this.chunkHandlers.add(handler);
    return () => this.chunkHandlers.delete(handler);
  }

  onControl(handler: ControlHandler): () => void {
    this.controlHandlers.add(handler);
    return () => this.controlHandlers.delete(handler);
  }

  onOpen(handler: OpenHandler): () => void {
    this.openHandlers.add(handler);
    return () => this.openHandlers.delete(handler);
  }

  disconnect(): void {
    this.alive = false;
    window.clearInterval(this.heartbeat);
    this.ws?.close();
    this.ws = null;
  }
}
