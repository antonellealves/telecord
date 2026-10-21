/**
 * Perfil de VOZ do telecord, copiado da configuração que o Discord usa.
 *
 * A referência é um dump do `chrome://webrtc-internals` do Discord (Chrome
 * 155, Windows). Este módulo não tem dependência de runtime — nem do LiveKit,
 * nem do mediasoup — para que os dois transportes, a auditoria e os testes
 * leiam os mesmos números.
 *
 * ## O que o Discord faz, e o telecord passa a fazer
 *
 * - Captura com o processamento de voz do navegador LIGADO (`ideal`, não
 *   `exact`: aparelho que não tem um deles degrada em vez de falhar), no
 *   dispositivo escolhido pelo id exato, sem forçar taxa nem canais.
 * - Opus mono a 48 kHz, quadro de 20 ms (o padrão — nada de `ptime`).
 * - FEC dentro do Opus (`useinbandfec=1`) e DTX (`usedtx=1`): calado, o
 *   microfone cai para ~1–2 kbps em vez de gastar o mesmo que falando.
 * - NACK e transport-cc no áudio.
 * - Sem RED, sem estéreo: um codec, um canal.
 * - Teto de 64 kbps no `RTCRtpSender`.
 */

// ---------------------------------------------------------------------------
// Bitrate
// ---------------------------------------------------------------------------

/** Os níveis oferecidos por sala. 64 kbps é o padrão do Discord. */
export const VOICE_BITRATE_OPTIONS = [64_000, 96_000, 128_000] as const;

export type VoiceBitrate = (typeof VOICE_BITRATE_OPTIONS)[number];

export const DEFAULT_VOICE_BITRATE: VoiceBitrate = 64_000;

export function isVoiceBitrate(value: unknown): value is VoiceBitrate {
  return typeof value === 'number' && (VOICE_BITRATE_OPTIONS as readonly number[]).includes(value);
}

/** Rótulo curto para o seletor. */
export function voiceBitrateLabel(bitrate: VoiceBitrate): string {
  const kbps = bitrate / 1000;
  return bitrate === DEFAULT_VOICE_BITRATE ? `${kbps} kbps (padrão)` : `${kbps} kbps`;
}

// ---------------------------------------------------------------------------
// Captura
// ---------------------------------------------------------------------------

export interface VoiceCapturePrefs {
  /**
   * Id CONCRETO do microfone. `null` só quando não há nenhum para escolher:
   * aí o navegador decide. Nunca `'default'` — ver `resolveInputDevice`.
   */
  deviceId: string | null;
  noiseSuppression: boolean;
  echoCancellation: boolean;
}

/**
 * As constraints de `getUserMedia` para a voz.
 *
 * Sem `sampleRate` nem `channelCount`: o Chrome processa a voz a 48 kHz
 * internamente seja qual for a taxa da placa, e forçar um valor que o
 * aparelho não tem só troca o driver por uma reamostragem do navegador.
 */
export function voiceCaptureConstraints(prefs: VoiceCapturePrefs): MediaTrackConstraints {
  return {
    ...(prefs.deviceId !== null && prefs.deviceId !== '' ? { deviceId: { exact: prefs.deviceId } } : {}),
    echoCancellation: { ideal: prefs.echoCancellation },
    autoGainControl: { ideal: true },
    noiseSuppression: { ideal: prefs.noiseSuppression },
  };
}

/** Lê o valor de uma constraint booleana em qualquer das formas aceitas. */
export function constraintBoolean(value: ConstrainBoolean | undefined): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return undefined;
  if (typeof value.exact === 'boolean') return value.exact;
  if (typeof value.ideal === 'boolean') return value.ideal;
  return undefined;
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

/** O payload type que o Chrome dá ao Opus — o mesmo que aparece no dump do Discord. */
export const OPUS_PAYLOAD_TYPE = 111;

/**
 * `a=fmtp` do Opus que o ENCODER recebe (a resposta do servidor ao microfone).
 * É o que o webrtc-internals mostra como
 * `opus (111, minptime=10;usedtx=1;useinbandfec=1)`.
 */
export const OPUS_SEND_FMTP: Readonly<Record<string, string>> = {
  minptime: '10',
  useinbandfec: '1',
  usedtx: '1',
};

/** `a=fmtp` do Opus do lado que RECEBE — o padrão do Chrome, sem nada a mais. */
export const OPUS_RECV_FMTP: Readonly<Record<string, string>> = {
  minptime: '10',
  useinbandfec: '1',
};

/** `a=rtcp-fb` que o Opus da voz precisa ter. */
export const VOICE_RTCP_FEEDBACK = ['nack', 'transport-cc'] as const;

export const AUDIO_LEVEL_EXTENSION = 'urn:ietf:params:rtp-hdrext:ssrc-audio-level';
export const TRANSPORT_CC_EXTENSION = 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01';

// ---------------------------------------------------------------------------
// Conexão
// ---------------------------------------------------------------------------

/**
 * O que toda `RTCPeerConnection` de voz pede. Os `iceServers` ficam de fora de
 * propósito: quem os fornece é o servidor de cada transporte (o LiveKit manda
 * os dele no join; o mediasoup anuncia os candidatos do próprio Worker).
 */
export const VOICE_RTC_CONFIGURATION: RTCConfiguration = {
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
};

// ---------------------------------------------------------------------------
// Referência medida no Discord (mesma rede)
// ---------------------------------------------------------------------------

export const DISCORD_REFERENCE = {
  rttMs: 15,
  lossPercent: 0,
  /** Concealment que não é silêncio, em % das amostras recebidas. */
  concealmentPercentMax: 1,
  speakingKbps: 64,
  silenceKbps: 1.6,
  /** Atraso do jitter buffer: alvo de 20–60 ms, playout em torno de 42 ms. */
  jitterBufferMs: 42,
} as const;
