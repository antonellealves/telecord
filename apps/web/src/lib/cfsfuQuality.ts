/**
 * Qualidade do compartilhamento de tela no transporte cfsfu (Cloudflare).
 *
 * A razão de existir desta opção é qualidade máxima: o SFU da Cloudflare é
 * passthrough (não recodifica), então o que chega ao assinante é exatamente o
 * que o navegador de quem compartilha codificou. Todo o trabalho é do lado de
 * quem publica — resolução, framerate, teto de bitrate e codec.
 */

export type ScreenShareQualityId = 'HD' | 'FHD' | 'QHD' | 'UHD';

export interface ScreenShareQualityOption {
  id: ScreenShareQualityId;
  label: string;
  width: number;
  height: number;
  fps: number;
}

/**
 * FHD é o padrão. QHD/UHD ficam disponíveis, mas nunca são FORÇADOS: a captura
 * pede como `ideal`, e `getSettings()` diz o que o navegador entregou de fato —
 * é o que evita prometer 4K numa máquina que não dá conta.
 */
export const SCREEN_SHARE_QUALITIES: ScreenShareQualityOption[] = [
  { id: 'HD', label: '720p', width: 1280, height: 720, fps: 30 },
  { id: 'FHD', label: '1080p', width: 1920, height: 1080, fps: 30 },
  { id: 'QHD', label: '1440p', width: 2560, height: 1440, fps: 30 },
  { id: 'UHD', label: '2160p', width: 3840, height: 2160, fps: 30 },
];

export const DEFAULT_SCREEN_SHARE_QUALITY: ScreenShareQualityId = 'FHD';

export function screenShareQuality(id: ScreenShareQualityId): ScreenShareQualityOption {
  return (
    SCREEN_SHARE_QUALITIES.find((option) => option.id === id) ??
    SCREEN_SHARE_QUALITIES[1]!
  );
}

/** Tetos de bitrate oferecidos na UI, em bits por segundo. */
export type BitrateCeilingId = '6' | '12' | '20';

export const BITRATE_CEILINGS: { id: BitrateCeilingId; label: string; bps: number }[] = [
  { id: '6', label: '6 Mbps', bps: 6_000_000 },
  { id: '12', label: '12 Mbps', bps: 12_000_000 },
  { id: '20', label: '20 Mbps', bps: 20_000_000 },
];

export const DEFAULT_BITRATE_CEILING: BitrateCeilingId = '12';

export function bitrateCeilingBps(id: BitrateCeilingId): number {
  return BITRATE_CEILINGS.find((option) => option.id === id)?.bps ?? 12_000_000;
}

/**
 * Constraints de captura de tela.
 *
 * `ideal` e não `exact`: um monitor menor que o alvo degrada em vez de FALHAR
 * (com `exact`, clicar em compartilhar não sairia nada). A nitidez vem depois,
 * do `contentHint: 'detail'`, do teto de bitrate alto e do
 * `degradationPreference: 'maintain-resolution'` no sender.
 */
export function screenShareConstraints(id: ScreenShareQualityId): DisplayMediaStreamOptions {
  const quality = screenShareQuality(id);
  return {
    video: {
      width: { ideal: quality.width },
      height: { ideal: quality.height },
      frameRate: { ideal: quality.fps, max: quality.fps },
    },
    // Áudio da aba/janela sobe sem processamento de voz: AEC/NS destruiriam o
    // som do conteúdo. Estéreo 48 kHz para o áudio do que está sendo mostrado.
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
      sampleRate: 48_000,
    },
  };
}

/**
 * Ordena os codecs de vídeo por preferência para tela, filtrando pelo que o
 * navegador realmente oferece. Só REORDENA — a negociação com o SFU sempre acha
 * um codec comum, e quem não tem VP9/AV1 cai em H264 sem quebrar.
 *
 * VP9 primeiro: melhor nitidez de texto por bit e amplamente disponível para
 * ENCODE nos navegadores. AV1 em seguida (melhor ainda, porém caro de
 * codificar e nem sempre disponível). H264 de reserva, universal. H265 é
 * suportado pelo SFU, mas o encode em navegador é raro, então não entra na
 * preferência de envio.
 */
export function preferScreenCodecs(transceiver: RTCRtpTransceiver): void {
  if (typeof RTCRtpSender === 'undefined' || !('getCapabilities' in RTCRtpSender)) return;
  const caps = RTCRtpSender.getCapabilities('video');
  if (caps === null) return;
  if (!('setCodecPreferences' in transceiver)) return;

  const order = ['video/vp9', 'video/av1', 'video/h264'];
  const rank = (codec: RTCRtpCodecCapabilityLike): number => {
    const index = order.indexOf(codec.mimeType.toLowerCase());
    return index === -1 ? order.length : index;
  };
  const sorted = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
  try {
    transceiver.setCodecPreferences(sorted);
  } catch {
    // Navegador sem suporte: segue na ordem padrão dele.
  }
}

/** O nome do tipo do codec varia entre versões do lib.dom; só usamos o mimeType. */
type RTCRtpCodecCapabilityLike = { mimeType: string };
