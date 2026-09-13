/**
 * Escolha de codec e configuração do encoder de áudio para o Vercel Relay.
 *
 * Opus é o único candidato: suportado em todo navegador com WebCodecs, ótima
 * compressão em taxa baixa, latência pensada para chamada. SPEC não pede
 * fallback aqui — ao contrário do vídeo, não há um segundo codec universal que
 * valha a pena testar.
 */

const OPUS_CODEC = 'opus';
const SAMPLE_RATE = 48_000;
const CHANNELS = 1;
/** Voz: 24-32kbps já soa bem em Opus; bem abaixo do menor teto de vídeo. */
const BITRATE = 32_000;

export interface AudioResolution {
  sampleRate: number;
  numberOfChannels: number;
  bitrate: number;
}

export const MIC_RESOLUTION: AudioResolution = {
  sampleRate: SAMPLE_RATE,
  numberOfChannels: CHANNELS,
  bitrate: BITRATE,
};

export async function isOpusEncodeSupported(res: AudioResolution): Promise<boolean> {
  if (typeof AudioEncoder === 'undefined') return false;
  try {
    const support = await AudioEncoder.isConfigSupported({
      codec: OPUS_CODEC,
      sampleRate: res.sampleRate,
      numberOfChannels: res.numberOfChannels,
      bitrate: res.bitrate,
    });
    return support.supported === true;
  } catch {
    return false;
  }
}

export function audioDecoderConfig(sampleRate: number, numberOfChannels: number): AudioDecoderConfig {
  return { codec: OPUS_CODEC, sampleRate, numberOfChannels };
}

export { OPUS_CODEC };
