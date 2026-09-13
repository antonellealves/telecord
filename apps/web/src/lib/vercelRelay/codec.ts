/**
 * Escolha de codec e configuração do encoder para o Vercel Relay.
 *
 * VP9 primeiro (melhor compressão para tela, amplamente disponível para ENCODE
 * em Chromium), H.264 de reserva (universal). A escolha é FEITA, não assumida:
 * `VideoEncoder.isConfigSupported` diz o que a máquina realmente aceita, e a
 * primeira que passar vence — sem quebrar quem não tem VP9. SPEC §3/§4.
 */

export type CodecLabel = 'VP9' | 'H.264';

interface CodecCandidate {
  codec: string;
  label: CodecLabel;
}

/*
 * H.264 em `annexb`: os keyframes carregam SPS/PPS embutidos, então o viewer
 * monta o `VideoDecoder` sem precisar de um `description` avcC fora de banda —
 * o `init` fica leve, só codec e dimensões. VP9 já dispensa `description`.
 */
const CANDIDATES: CodecCandidate[] = [
  { codec: 'vp09.00.10.08', label: 'VP9' },
  { codec: 'avc1.42E01F', label: 'H.264' },
];

export interface ScreenResolution {
  width: number;
  height: number;
  fps: number;
  /** bits por segundo. */
  bitrate: number;
}

export interface ChosenCodec {
  label: CodecLabel;
  /** Config já normalizada pelo navegador, pronta para `new VideoEncoder().configure`. */
  config: VideoEncoderConfig;
}

function encoderConfig(candidate: CodecCandidate, res: ScreenResolution): VideoEncoderConfig {
  const base: VideoEncoderConfig = {
    codec: candidate.codec,
    width: res.width,
    height: res.height,
    framerate: res.fps,
    bitrate: res.bitrate,
    // Realtime: prioriza latência baixa em vez de qualidade por bit — é chamada,
    // não gravação.
    latencyMode: 'realtime',
  };
  if (candidate.label === 'H.264') {
    return { ...base, avc: { format: 'annexb' } };
  }
  return base;
}

/** Testa os candidatos em ordem; devolve o primeiro suportado, ou `null`. */
export async function chooseScreenCodec(res: ScreenResolution): Promise<ChosenCodec | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const candidate of CANDIDATES) {
    const wanted = encoderConfig(candidate, res);
    try {
      const support = await VideoEncoder.isConfigSupported(wanted);
      if (support.supported === true && support.config !== undefined) {
        return { label: candidate.label, config: support.config };
      }
    } catch {
      // Config recusada de tão fora do padrão: passa para o próximo candidato.
    }
  }
  return null;
}

/** Config do decoder para o viewer, a partir do que o `init` anunciou. */
export function decoderConfig(codec: string, width: number, height: number): VideoDecoderConfig {
  return {
    codec,
    codedWidth: width,
    codedHeight: height,
    // Sem `description`: VP9 dispensa, e o H.264 vem em annexb (SPS/PPS no
    // próprio keyframe). `optimizeForLatency` deixa o decoder emitir o quadro
    // assim que possível, sem segurar para reordenar.
    optimizeForLatency: true,
  };
}
