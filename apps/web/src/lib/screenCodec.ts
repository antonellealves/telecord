/**
 * Com qual codec a TELA é publicada na sala LiveKit.
 *
 * ## Por que AV1, medido
 *
 * A/B com o livekit-client 2.22 e o servidor 1.13, Chrome 154, tela sintética
 * 1080p60 com as opções reais de publicação, comparando o que chega com a
 * cena original (PSNR de luma; maior é mais fiel). Duas rodadas por codec, em
 * ordem alternada, depois de uma publicação de aquecimento descartada:
 *
 * | conteúdo, teto 12 Mbps | VP8     | H.264   | VP9     | AV1      |
 * | ---------------------- | ------- | ------- | ------- | -------- |
 * | jogo (muito movimento) | 31,2 dB | 43,8 dB | 41,2 dB | 44,8 dB  |
 * | — codificação/quadro   | 7,5 ms  | 12,4 ms | 7,0 ms  | 9,8 ms   |
 * | texto fino rolando     | 43,8 dB | 45,4 dB | 48,3 dB | 46,3 dB  |
 * | — banda usada          | 12 Mbps | 9,8     | 11,6    | 1,6 Mbps |
 * | — codificação/quadro   | 6,6 ms  | 10 ms   | 7,6 ms  | 4,5 ms   |
 *
 * Em movimento o AV1 entrega 3,6 dB a mais que o VP9 na mesma banda, pagando
 * ~40% a mais de CPU para codificar. Em texto ele tem ferramentas próprias
 * para conteúdo de tela e não gasta o teto: fica 2 dB abaixo do VP9 usando um
 * sétimo da banda — e banda de tela é multiplicada por cada pessoa assistindo
 * na saída do SFU, que é o recurso mais apertado desta infraestrutura.
 *
 * O H.264 por software fica atrás do AV1 nos dois conteúdos e é o que mais
 * gasta CPU. Ele só compensaria com o codificador da placa de vídeo, e neste
 * caminho o Chrome não usou um (testado numa RTX 4070: `powerEfficient`
 * falso para os quatro codecs).
 *
 * Os números são de UMA máquina (i9-14900K). Num processador mais fraco o
 * custo de codificar sobe para todos, e é por isso que a escolha passa pela
 * consulta abaixo em vez de ser fixa.
 *
 * ## A queda
 *
 * AV1 só entra onde o navegador diz que codifica E que dá conta do tamanho
 * pedido sem engasgar; senão fica o VP9 de antes. Abaixo disso, o próprio SDK
 * cai para o VP8 quando o navegador não publica nenhum dos dois (Firefox), e
 * o `backupCodec` VP8 atende quem assiste sem decodificar o codec principal.
 */
export type ScreenCodec = 'av1' | 'vp9';

export interface ScreenCodecEvidence {
  /** O navegador lista AV1 entre os codecs que sabe ENVIAR por WebRTC. */
  av1Listed: boolean;
  /** `mediaCapabilities` diz que codifica AV1 neste tamanho, e sem engasgar. */
  av1Smooth: boolean;
}

export function chooseScreenCodec(evidence: ScreenCodecEvidence): ScreenCodec {
  return evidence.av1Listed && evidence.av1Smooth ? 'av1' : 'vp9';
}

/** O tamanho mais pesado que o app publica com dimensão fixa: 1080p60 a 12 Mbps. */
const PROBE: VideoConfiguration = {
  contentType: 'video/AV1',
  width: 1920,
  height: 1080,
  framerate: 60,
  bitrate: 12_000_000,
};

async function gatherEvidence(): Promise<ScreenCodecEvidence> {
  const none: ScreenCodecEvidence = { av1Listed: false, av1Smooth: false };
  if (typeof RTCRtpSender === 'undefined' || typeof navigator === 'undefined') return none;
  const codecs = RTCRtpSender.getCapabilities?.('video')?.codecs ?? [];
  const av1Listed = codecs.some((codec) => codec.mimeType.toLowerCase() === 'video/av1');
  if (!av1Listed || navigator.mediaCapabilities === undefined) return { av1Listed, av1Smooth: false };
  try {
    const info = await navigator.mediaCapabilities.encodingInfo({ type: 'webrtc', video: PROBE });
    return { av1Listed, av1Smooth: info.supported && info.smooth };
  } catch {
    // Navegador que não conhece `type: 'webrtc'`: sem resposta, não arrisca.
    return { av1Listed, av1Smooth: false };
  }
}

let detected: ScreenCodec = 'vp9';
let detection: Promise<ScreenCodec> | null = null;

/**
 * Descobre o codec uma vez por página. Chamado ao entrar na sala, para a
 * resposta já existir na hora do clique — `getDisplayMedia` precisa do gesto
 * da pessoa, e esperar uma consulta ali poderia gastá-lo.
 */
export function detectScreenCodec(): Promise<ScreenCodec> {
  detection ??= gatherEvidence().then((evidence) => {
    detected = chooseScreenCodec(evidence);
    return detected;
  });
  return detection;
}

/**
 * O codec para uma transmissão. VP9, o comportamento de antes, enquanto a
 * detecção não termina — e sempre que a tela sai na resolução nativa: a
 * consulta e a medição foram feitas em 1080p, e nada garante que o AV1 por
 * software segure 1440p ou 4K a 60 quadros.
 */
export function screenCodec(nativeResolution = false): ScreenCodec {
  return nativeResolution ? 'vp9' : detected;
}
