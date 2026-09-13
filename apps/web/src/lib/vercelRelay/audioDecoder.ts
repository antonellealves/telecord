/**
 * Lado de quem escuta: decodifica chunks Opus com `AudioDecoder` e toca via
 * Web Audio. Cada `AudioData` decodificado vira um `AudioBuffer` agendado em
 * sequência num `AudioContext` — um pequeno buffer de jitter (a fila de nós
 * agendados) absorve variação de chegada sem acumular atraso sem fim.
 *
 * Voz é muitos-para-muitos: um decoder por pessoa falando (`MicDecoderRegistry`),
 * identificada pelo `senderId` embutido no payload de áudio (ver
 * `encodeAudioPayload`/`decodeAudioPayload` em `@telecord/shared`). A config do
 * Opus é fixa no app inteiro (`MIC_RESOLUTION`), então cada decoder novo já
 * nasce configurado — não depende de receber o `audio-init` de quem fala.
 */
import { decodeAudioPayload, type VideoChunkFrame } from '@telecord/shared';
import { MIC_RESOLUTION, OPUS_CODEC } from './audioCodec';

class MicDecoder {
  private readonly decoder: AudioDecoder;
  private readonly context: AudioContext;
  private nextPlayAt = 0;

  constructor() {
    this.context = new AudioContext({ sampleRate: MIC_RESOLUTION.sampleRate });
    this.decoder = new AudioDecoder({
      output: (data) => this.play(data),
      error: () => {
        // Opus não tem conceito de keyframe — quadro perdido, os próximos seguem.
      },
    });
    this.decoder.configure({
      codec: OPUS_CODEC,
      sampleRate: MIC_RESOLUTION.sampleRate,
      numberOfChannels: MIC_RESOLUTION.numberOfChannels,
    });
  }

  push(opus: Uint8Array, timestamp: number): void {
    if (this.decoder.state !== 'configured') return;
    const chunk = new EncodedAudioChunk({ type: 'key', timestamp, data: opus });
    try {
      this.decoder.decode(chunk);
    } catch {
      // Chunk indecodificável: descarta, o próximo segue normal.
    }
  }

  private play(data: AudioData): void {
    const channels = MIC_RESOLUTION.numberOfChannels;
    const buffer = this.context.createBuffer(channels, data.numberOfFrames, data.sampleRate);
    for (let channel = 0; channel < channels; channel += 1) {
      buffer.copyToChannel(new Float32Array(data.numberOfFrames), channel);
      const target = buffer.getChannelData(channel);
      data.copyTo(target, { planeIndex: channel });
    }
    data.close();

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const startAt = Math.max(this.nextPlayAt, this.context.currentTime + 0.02);
    source.start(startAt);
    this.nextPlayAt = startAt + buffer.duration;
  }

  close(): void {
    if (this.decoder.state !== 'closed') this.decoder.close();
    void this.context.close().catch(() => undefined);
  }
}

export class MicDecoderRegistry {
  private readonly decoders = new Map<string, MicDecoder>();

  push(frame: VideoChunkFrame): void {
    if (frame.kind !== 'audio') return;
    const payload = decodeAudioPayload(frame.data);
    if (payload === null) return;
    let decoder = this.decoders.get(payload.senderId);
    if (decoder === undefined) {
      decoder = new MicDecoder();
      this.decoders.set(payload.senderId, decoder);
    }
    decoder.push(payload.opus, frame.timestamp);
  }

  /** Alguém saiu ou parou de falar: libera o `AudioContext` dela. */
  removePeer(peerId: string): void {
    this.decoders.get(peerId)?.close();
    this.decoders.delete(peerId);
  }

  closeAll(): void {
    for (const decoder of this.decoders.values()) decoder.close();
    this.decoders.clear();
  }
}
