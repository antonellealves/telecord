/**
 * Lado de quem fala: captura o microfone e codifica com `AudioEncoder` (Opus),
 * publicando chunks no mesmo transporte do vídeo — o cabeçalho binário
 * distingue os dois (`kind`). Roda em paralelo ao `ScreenEncoder`, ou sozinho
 * quando não há compartilhamento de tela.
 */
import { encodeAudioPayload, type VideoChunkFrame } from '@telecord/shared';
import { MIC_RESOLUTION, OPUS_CODEC, isOpusEncodeSupported } from './audioCodec';
import type { ScreenStreamTransport } from './transport';

interface AudioTrackProcessor {
  readonly readable: ReadableStream<AudioData>;
}
interface AudioTrackProcessorCtor {
  new (init: { track: MediaStreamTrack }): AudioTrackProcessor;
}
declare const MediaStreamTrackProcessor: AudioTrackProcessorCtor | undefined;

export class MicEncoder {
  private encoder: AudioEncoder | null = null;
  private track: MediaStreamTrack | null = null;
  private reader: ReadableStreamDefaultReader<AudioData> | null = null;
  private sequence = 0;
  private running = false;
  private peerId = '';

  async start(
    stream: MediaStream,
    peerId: string,
    transport: ScreenStreamTransport,
    onError: (message: string) => void,
  ): Promise<void> {
    this.peerId = peerId;
    const supported = await isOpusEncodeSupported(MIC_RESOLUTION);
    if (!supported) {
      throw new Error('Este navegador não codifica áudio Opus (AudioEncoder).');
    }
    if (typeof MediaStreamTrackProcessor === 'undefined') {
      throw new Error('Este navegador não expõe a captura de áudio (MediaStreamTrackProcessor).');
    }

    const track = stream.getAudioTracks()[0];
    if (track === undefined) throw new Error('O microfone não trouxe áudio.');
    this.track = track;
    track.addEventListener('ended', () => this.stop());

    this.encoder = new AudioEncoder({
      output: (chunk) => this.emit(chunk, transport),
      error: (error: DOMException) => onError(error.message),
    });
    this.encoder.configure({
      codec: OPUS_CODEC,
      sampleRate: MIC_RESOLUTION.sampleRate,
      numberOfChannels: MIC_RESOLUTION.numberOfChannels,
      bitrate: MIC_RESOLUTION.bitrate,
    });

    transport.sendControl({
      t: 'audio-init',
      codec: OPUS_CODEC,
      sampleRate: MIC_RESOLUTION.sampleRate,
      numberOfChannels: MIC_RESOLUTION.numberOfChannels,
      bitrate: MIC_RESOLUTION.bitrate,
    });

    const processor = new MediaStreamTrackProcessor({ track });
    this.reader = processor.readable.getReader();
    this.running = true;
    void this.pump(onError);
  }

  private async pump(onError: (message: string) => void): Promise<void> {
    const reader = this.reader;
    const encoder = this.encoder;
    if (reader === null || encoder === null) return;
    try {
      while (this.running) {
        const { value: data, done } = await reader.read();
        if (done || data === undefined) break;
        if (encoder.encodeQueueSize > 4) {
          data.close();
          continue;
        }
        encoder.encode(data);
        data.close();
      }
    } catch (error) {
      if (this.running) onError(error instanceof Error ? error.message : 'Falha ao codificar áudio.');
    }
  }

  private emit(chunk: EncodedAudioChunk, transport: ScreenStreamTransport): void {
    const opus = new Uint8Array(chunk.byteLength);
    chunk.copyTo(opus);
    const frame: VideoChunkFrame = {
      kind: 'audio',
      sequenceNumber: this.sequence,
      timestamp: chunk.timestamp,
      keyframe: true,
      data: encodeAudioPayload(this.peerId, opus),
    };
    this.sequence += 1;
    transport.publishChunk(frame);
  }

  stop(transport?: ScreenStreamTransport): void {
    this.running = false;
    void this.reader?.cancel().catch(() => undefined);
    this.reader = null;
    if (this.encoder !== null && this.encoder.state !== 'closed') {
      this.encoder.close();
    }
    this.encoder = null;
    this.track?.stop();
    this.track = null;
    transport?.sendControl({ t: 'audio-end' });
  }
}
