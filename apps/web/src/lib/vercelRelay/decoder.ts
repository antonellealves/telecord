/**
 * Lado de quem assiste: recebe os chunks, decodifica com WebCodecs e desenha os
 * quadros num canvas. Nada de base64, `<img>` ou JPEG por quadro — `VideoFrame`
 * direto no canvas (SPEC §10).
 */
import { SequenceTracker, type VideoChunkFrame } from '@telecord/shared';
import { decoderConfig } from './codec';

export interface DecoderStats {
  framesDecoded: number;
  droppedChunks: number;
  keyframes: number;
  width: number;
  height: number;
  /** FPS decodificado, medido numa janela curta. */
  fps: number;
}

export class ScreenDecoder {
  private decoder: VideoDecoder | null = null;
  private readonly tracker = new SequenceTracker();
  private codec: string | null = null;
  private readonly stats: DecoderStats = {
    framesDecoded: 0,
    droppedChunks: 0,
    keyframes: 0,
    width: 0,
    height: 0,
    fps: 0,
  };
  private frameTimes: number[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onRequestKeyframe: () => void,
  ) {}

  getStats(): DecoderStats {
    return { ...this.stats };
  }

  /** (Re)configura o decoder com o que o `init` anunciou. */
  configure(codec: string, width: number, height: number): void {
    // Mesmo codec e tamanho: nada a fazer.
    if (this.decoder !== null && this.codec === codec && this.stats.width === width) return;
    this.close();
    this.codec = codec;
    this.stats.width = width;
    this.stats.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.tracker.reset();

    const context = this.canvas.getContext('2d');
    this.decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        this.stats.framesDecoded += 1;
        this.measureFps();
        if (context !== null) {
          context.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
        }
        frame.close();
      },
      error: () => {
        // Decoder quebrou (referência perdida): pede keyframe para reancorar.
        this.onRequestKeyframe();
      },
    });
    this.decoder.configure(decoderConfig(codec, width, height));
  }

  /** Um chunk chegou: decide (via sequência) se decodifica, descarta ou pede keyframe. */
  push(frame: VideoChunkFrame): void {
    if (frame.kind !== 'video') return;
    const decision = this.tracker.receive(frame.sequenceNumber, frame.keyframe);
    if (decision.requestKeyframe) this.onRequestKeyframe();
    if (!decision.decode) {
      this.stats.droppedChunks += 1;
      return;
    }
    if (this.decoder === null || this.decoder.state !== 'configured') {
      this.stats.droppedChunks += 1;
      return;
    }
    if (frame.keyframe) this.stats.keyframes += 1;
    const chunk = new EncodedVideoChunk({
      type: frame.keyframe ? 'key' : 'delta',
      timestamp: frame.timestamp,
      data: frame.data,
    });
    try {
      this.decoder.decode(chunk);
    } catch {
      // Chunk indecodificável: descarta e pede keyframe.
      this.stats.droppedChunks += 1;
      this.onRequestKeyframe();
    }
  }

  /** Reconexão / troca de streamer: recomeça a contagem de sequência. */
  reset(): void {
    this.tracker.reset();
    this.onRequestKeyframe();
  }

  private measureFps(): void {
    const now = performance.now();
    this.frameTimes.push(now);
    // Janela de 1 s.
    while (this.frameTimes.length > 0 && now - this.frameTimes[0]! > 1_000) {
      this.frameTimes.shift();
    }
    this.stats.fps = this.frameTimes.length;
  }

  close(): void {
    if (this.decoder !== null && this.decoder.state !== 'closed') {
      this.decoder.close();
    }
    this.decoder = null;
  }
}
