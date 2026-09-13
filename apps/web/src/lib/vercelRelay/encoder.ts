/**
 * Lado de quem compartilha: captura a tela, codifica com WebCodecs e publica os
 * chunks no transporte. Nada de MediaRecorder — `VideoEncoder` direto, para os
 * chunks saírem comprimidos e prontos para o relay repassar sem tocar.
 */
import type { VideoChunkFrame } from '@telecord/shared';
import { chooseScreenCodec, type ChosenCodec, type ScreenResolution } from './codec';
import type { ScreenStreamTransport } from './transport';

export interface EncoderStats {
  codecLabel: string;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  chunksSent: number;
  bytesSent: number;
  /** Fila do encoder — se cresce, a CPU não está dando conta. */
  encodeQueue: number;
  keyframes: number;
}

/*
 * `MediaStreamTrackProcessor` (Chromium) transforma a track de vídeo num fluxo
 * de `VideoFrame`s para o encoder. Ainda fora do lib.dom em algumas versões, daí
 * a declaração mínima — só o que usamos.
 */
interface TrackProcessor {
  readonly readable: ReadableStream<VideoFrame>;
}
interface TrackProcessorCtor {
  new (init: { track: MediaStreamTrack }): TrackProcessor;
}
declare const MediaStreamTrackProcessor: TrackProcessorCtor | undefined;

/** Um keyframe a cada ~1,5 s (SPEC §5): começo rápido para quem entra. */
const KEYFRAME_INTERVAL_MS = 1_500;

export class ScreenEncoder {
  private encoder: VideoEncoder | null = null;
  private track: MediaStreamTrack | null = null;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private sequence = 0;
  private running = false;
  private forceKeyframe = true;
  private lastKeyframeAt = 0;
  private readonly stats: EncoderStats = {
    codecLabel: '',
    width: 0,
    height: 0,
    fps: 0,
    bitrate: 0,
    chunksSent: 0,
    bytesSent: 0,
    encodeQueue: 0,
    keyframes: 0,
  };

  getStats(): EncoderStats {
    if (this.encoder !== null) this.stats.encodeQueue = this.encoder.encodeQueueSize;
    return { ...this.stats };
  }

  /** Ajusta o teto de bitrate ao vivo (adaptive bitrate). */
  updateBitrate(bitrate: number): void {
    if (this.encoder === null) return;
    this.stats.bitrate = bitrate;
    // `configure` de novo com o mesmo codec só muda o bitrate, sem recriar o
    // encoder — o próximo keyframe já sai no novo teto.
    try {
      this.encoder.configure({
        codec: this.encoderConfig.codec,
        width: this.encoderConfig.width,
        height: this.encoderConfig.height,
        framerate: this.encoderConfig.framerate,
        bitrate,
        latencyMode: 'realtime',
        ...(this.encoderConfig.avc !== undefined ? { avc: this.encoderConfig.avc } : {}),
      });
      this.forceKeyframe = true;
    } catch {
      // Reconfiguração recusada: segue no bitrate anterior.
    }
  }

  private encoderConfig!: VideoEncoderConfig;

  async start(
    stream: MediaStream,
    res: ScreenResolution,
    transport: ScreenStreamTransport,
    onError: (message: string) => void,
  ): Promise<ChosenCodec> {
    const chosen = await chooseScreenCodec(res);
    if (chosen === null) {
      throw new Error('Nenhum codec de vídeo suportado para o streaming HD.');
    }
    if (typeof MediaStreamTrackProcessor === 'undefined') {
      throw new Error('Este navegador não expõe a captura de quadros (MediaStreamTrackProcessor).');
    }

    this.encoderConfig = chosen.config;
    this.stats.codecLabel = chosen.label;
    this.stats.width = res.width;
    this.stats.height = res.height;
    this.stats.fps = res.fps;
    this.stats.bitrate = res.bitrate;

    this.encoder = new VideoEncoder({
      output: (chunk) => this.emit(chunk, transport),
      error: (error: DOMException) => onError(error.message),
    });
    this.encoder.configure(chosen.config);

    // O viewer precisa da config do decoder antes do primeiro chunk.
    transport.sendControl({
      t: 'init',
      codec: chosen.config.codec,
      width: res.width,
      height: res.height,
      fps: res.fps,
      bitrate: res.bitrate,
    });

    const track = stream.getVideoTracks()[0];
    if (track === undefined) throw new Error('A captura de tela não trouxe vídeo.');
    this.track = track;
    // Se a pessoa parar pelo botão nativo do navegador, encerra também aqui.
    track.addEventListener('ended', () => this.stop());

    const processor = new MediaStreamTrackProcessor({ track });
    this.reader = processor.readable.getReader();
    this.running = true;
    void this.pump(onError);

    return chosen;
  }

  requestKeyframe(): void {
    this.forceKeyframe = true;
  }

  private async pump(onError: (message: string) => void): Promise<void> {
    const reader = this.reader;
    const encoder = this.encoder;
    if (reader === null || encoder === null) return;
    try {
      while (this.running) {
        const { value: frame, done } = await reader.read();
        if (done || frame === undefined) break;
        // Se o encoder está afogado, descarta o quadro (não enfileira sem fim).
        if (encoder.encodeQueueSize > 2) {
          frame.close();
          continue;
        }
        const now = performance.now();
        const key = this.forceKeyframe || now - this.lastKeyframeAt >= KEYFRAME_INTERVAL_MS;
        if (key) {
          this.forceKeyframe = false;
          this.lastKeyframeAt = now;
        }
        encoder.encode(frame, { keyFrame: key });
        frame.close();
      }
    } catch (error) {
      if (this.running) onError(error instanceof Error ? error.message : 'Falha ao codificar.');
    }
  }

  private emit(chunk: EncodedVideoChunk, transport: ScreenStreamTransport): void {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const frame: VideoChunkFrame = {
      sequenceNumber: this.sequence,
      timestamp: chunk.timestamp,
      keyframe: chunk.type === 'key',
      data,
    };
    this.sequence += 1;
    this.stats.chunksSent += 1;
    this.stats.bytesSent += data.byteLength;
    if (frame.keyframe) this.stats.keyframes += 1;
    transport.publishChunk(frame);
  }

  stop(): void {
    this.running = false;
    void this.reader?.cancel().catch(() => undefined);
    this.reader = null;
    if (this.encoder !== null && this.encoder.state !== 'closed') {
      this.encoder.close();
    }
    this.encoder = null;
    this.track?.stop();
    this.track = null;
  }
}
