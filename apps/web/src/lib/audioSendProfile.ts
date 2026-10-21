import { DEFAULT_VOICE_BITRATE, type VoiceBitrate } from './voice/voiceProfile';

/**
 * O que a voz e o áudio da tela DEVEM sair transmitindo na sala LiveKit — e a
 * conferência de que estão saindo assim.
 *
 * Fica num módulo sem dependência de runtime (nem do SDK) para que a mesma
 * definição alimente três coisas sem divergir: as opções de publicação
 * (`media.ts`), o orçamento de banda (`roomAudioDownlink`) e a auditoria do
 * `RTCRtpSender` real (`auditAudioSender`). Os testes em
 * `audioSendProfile.test.ts` amarram as três.
 *
 * ## A voz segue o Discord
 *
 * 64 kbps mono, Opus só (sem RED), FEC dentro do Opus e DTX ligado — o que
 * o dump do `webrtc-internals` do Discord mostra (ver `voice/voiceProfile.ts`).
 *
 * - **64 kbps**: o Opus mono já é transparente para fala aí. O teto sobe por
 *   sala (96/128) para quem quer folga, sem mudar o padrão.
 * - **Sem RED**: RED manda cada quadro duas vezes. O FEC do Opus e o NACK
 *   cobrem a perda isolada por uma fração do custo.
 * - **DTX ligado**: microfone aberto e calado cai para ~1–2 kbps. Numa sala
 *   cheia, quase todo mundo está calado quase sempre — é a maior economia
 *   de banda da sala.
 */

export interface AudioSendProfile {
  /** Teto do Opus no `RTCRtpSender`, em bits/s. É ESTE valor que manda no encoder. */
  maxBitrate: number;
  stereo: boolean;
  /** Redundância de pacote (RFC 2198): cada pacote leva também o quadro anterior. */
  red: boolean;
  /** Opus DTX: parar de enviar em trecho que o encoder julga silencioso. */
  dtx: boolean;
}

/** Microfone, no teto padrão. Para o teto escolhido na sala, `voiceProfileFor`. */
export const VOICE_PROFILE: AudioSendProfile = {
  maxBitrate: DEFAULT_VOICE_BITRATE,
  stereo: false,
  red: false,
  dtx: true,
};

export function voiceProfileFor(bitrate: VoiceBitrate): AudioSendProfile {
  return { ...VOICE_PROFILE, maxBitrate: bitrate };
}

/**
 * Áudio da tela compartilhada (vídeo, música, jogo).
 *
 * Estéreo a 128 kbps, onde o Opus fica transparente para música mixada. RED
 * desligado: um estalo no áudio de um vídeo incomoda bem menos que a imagem
 * travar. DTX desligado: música tem trecho baixo que não é silêncio.
 */
export const SCREEN_AUDIO_PROFILE: AudioSendProfile = {
  maxBitrate: 128_000,
  stereo: true,
  red: false,
  dtx: false,
};

// ---------------------------------------------------------------------------
// Orçamento de banda
// ---------------------------------------------------------------------------

/** Quadro de 20 ms, o padrão do Opus no WebRTC. */
const PACKETS_PER_SECOND = 50;

/**
 * Cabeçalho por pacote: IPv4 (20) + UDP (8) + RTP (12) + extensões que o
 * LiveKit negocia — audio level, transport-cc, mid — (~12) + tag SRTP (10).
 */
const PACKET_OVERHEAD_BYTES = 62;

/** Cabeçalho RED: 4 bytes do bloco redundante + 1 do primário. */
const RED_HEADER_BYTES = 5;

/** Custo no fio, em bits/s, de UM fluxo deste perfil com o encoder no teto. */
export function wireBitrate(profile: AudioSendProfile): number {
  const payload = profile.maxBitrate * (profile.red ? 2 : 1);
  const headerBytes = PACKET_OVERHEAD_BYTES + (profile.red ? RED_HEADER_BYTES : 0);
  return payload + PACKETS_PER_SECOND * headerBytes * 8;
}

export interface RoomAudioScenario {
  /** Quantas pessoas na sala, contando quem ouve. */
  participants: number;
  /** Quantas transmitem tela com áudio. */
  screenShares: number;
}

/**
 * Áudio que chega a UM ouvinte no pior caso: todo mundo FALANDO ao mesmo
 * tempo e as telas com áudio de outras pessoas. Com DTX, quem está calado
 * custa ~2 kbps — a conta abaixo ignora isso de propósito, para ser o teto.
 */
export function roomAudioDownlink(
  scenario: RoomAudioScenario,
  voice: AudioSendProfile = VOICE_PROFILE,
  screenAudio: AudioSendProfile = SCREEN_AUDIO_PROFILE,
): number {
  const others = Math.max(0, scenario.participants - 1);
  return others * wireBitrate(voice) + scenario.screenShares * wireBitrate(screenAudio);
}

/**
 * Teto do áudio de uma sala cheia (10 pessoas, uma tela com áudio) na descida
 * de cada ouvinte.
 *
 * A tela no nível máximo pede 25 Mbps. Numa conexão doméstica de 30 Mbps
 * sobram ~5, e o áudio — que tem prioridade sobre o vídeo — não pode comer
 * mais que metade dessa folga, senão é a tela que cede.
 */
export const ROOM_AUDIO_BUDGET = 2_500_000;

// ---------------------------------------------------------------------------
// Auditoria do sender real
// ---------------------------------------------------------------------------

/** O que interessa de `RTCRtpSender.getParameters().codecs`. */
export interface SenderCodec {
  mimeType: string;
  clockRate?: number;
  channels?: number;
  sdpFmtpLine?: string;
}

/** Uma leitura de `outbound-rtp` (`RTCRtpSender.getStats()`). */
export interface OutboundSample {
  /** Milissegundos, como em `RTCStats.timestamp`. */
  timestamp: number;
  /** Bytes de payload — o padrão exclui cabeçalho e padding. */
  bytesSent: number;
  /** Alvo atual do encoder, quando o navegador informa (Chromium informa). */
  targetBitrate?: number;
  /** `mimeType` do codec que de fato está saindo (via `codecId`). */
  codecMimeType?: string;
}

export interface AudioSenderSnapshot {
  maxBitrate: number | undefined;
  codecs: SenderCodec[];
  /** `MediaStreamTrack.getSettings()` da captura. */
  sampleRate?: number;
  /** Duas leituras espaçadas, para medir o bitrate real. */
  first?: OutboundSample;
  second?: OutboundSample;
}

export type AudioIssueCode =
  | 'max-bitrate'
  | 'no-opus'
  | 'opus-clock'
  | 'fec'
  | 'dtx'
  | 'stereo'
  | 'fmtp-ceiling'
  | 'red'
  | 'sample-rate'
  | 'extra-codecs'
  | 'target-bitrate'
  | 'overspend';

export interface AudioIssue {
  code: AudioIssueCode;
  message: string;
}

export interface AudioAudit {
  ok: boolean;
  issues: AudioIssue[];
  /** Bitrate de payload medido entre as duas leituras, em bits/s. */
  measuredBitrate?: number;
}

/** Folga da medição: o VBR passa um pouco do alvo em quadro de transiente. */
const MEASURE_TOLERANCE = 1.15;

function fmtpParams(line: string | undefined): Map<string, string> {
  const params = new Map<string, string>();
  for (const entry of (line ?? '').split(';')) {
    const [key, value] = entry.trim().split('=');
    if (key) params.set(key.toLowerCase(), (value ?? '').trim());
  }
  return params;
}

function isMime(codec: { mimeType?: string } | undefined, mime: string): boolean {
  return codec?.mimeType?.toLowerCase() === mime;
}

/**
 * Compara o que o sender está fazendo com o que o perfil manda fazer.
 *
 * Cada item pega um jeito conhecido de a configuração não chegar ao fio: o
 * SDK ignorar o `audioPreset`, o SFU responder um `fmtp` que corta o teto,
 * o DTX não ser negociado, o aparelho capturar em banda estreita, o Firefox
 * usar `maxaveragebitrate` como bitrate fixo, RED aparecer sem ser pedido.
 *
 * A captura não é forçada a 48 kHz nem a um canal (o Discord também não
 * força): 44,1 kHz é normal e não é acusado. Só banda de TELEFONE (abaixo de
 * 32 kHz) é, porque aí o agudo da voz já não existe antes do codec.
 */
export function auditAudioSender(snapshot: AudioSenderSnapshot, profile: AudioSendProfile): AudioAudit {
  const issues: AudioIssue[] = [];
  const kbps = (bps: number): string => `${Math.round(bps / 1000)} kbps`;

  if (snapshot.maxBitrate !== profile.maxBitrate) {
    issues.push({
      code: 'max-bitrate',
      message: `teto do sender é ${snapshot.maxBitrate === undefined ? 'nenhum' : kbps(snapshot.maxBitrate)}, o perfil pede ${kbps(profile.maxBitrate)}`,
    });
  }

  // Lista vazia é navegador que não expõe os codecs do sender: sem dado, e
  // não divergência.
  const opus = snapshot.codecs.find((codec) => isMime(codec, 'audio/opus'));
  if (opus === undefined && snapshot.codecs.length > 0) {
    issues.push({ code: 'no-opus', message: 'Opus não foi negociado' });
  } else if (opus !== undefined) {
    if (opus.clockRate !== undefined && opus.clockRate !== 48_000) {
      issues.push({ code: 'opus-clock', message: `Opus a ${opus.clockRate} Hz, esperado 48000` });
    }
    const fmtp = fmtpParams(opus.sdpFmtpLine);
    if (fmtp.get('useinbandfec') !== '1') {
      issues.push({ code: 'fec', message: 'FEC do Opus (useinbandfec) não negociado' });
    }
    if ((fmtp.get('usedtx') === '1') !== profile.dtx) {
      issues.push({ code: 'dtx', message: profile.dtx ? 'DTX pedido e não negociado' : 'DTX negociado e o perfil pede desligado' });
    }
    if ((fmtp.get('stereo') === '1') !== profile.stereo) {
      issues.push({ code: 'stereo', message: profile.stereo ? 'estéreo pedido e não negociado' : 'estéreo negociado num perfil mono' });
    }
    const ceiling = Number(fmtp.get('maxaveragebitrate'));
    if (Number.isFinite(ceiling) && ceiling > 0 && ceiling < profile.maxBitrate) {
      issues.push({ code: 'fmtp-ceiling', message: `maxaveragebitrate=${ceiling} no SDP corta abaixo de ${kbps(profile.maxBitrate)}` });
    }
  }

  // Com RED negociado, `codecs[0]` (o preferido para envio) é `audio/red`.
  const sending = snapshot.second?.codecMimeType ?? snapshot.codecs[0]?.mimeType;
  const sendingRed = sending?.toLowerCase() === 'audio/red';
  if (sending !== undefined && sendingRed !== profile.red) {
    issues.push({ code: 'red', message: profile.red ? 'RED pedido e saindo sem redundância' : 'RED saindo num perfil sem redundância' });
  }

  // `setCodecPreferences` deixa a seção só com o Opus. O RED tem item próprio acima.
  const extra = snapshot.codecs.filter((codec) => !isMime(codec, 'audio/opus') && !isMime(codec, 'audio/red'));
  if (extra.length > 0) {
    issues.push({ code: 'extra-codecs', message: `codecs além do Opus negociados: ${extra.map((codec) => codec.mimeType).join(', ')}` });
  }

  if (snapshot.sampleRate !== undefined && snapshot.sampleRate < 32_000) {
    issues.push({ code: 'sample-rate', message: `captura a ${snapshot.sampleRate} Hz — a banda alta morre antes do codec` });
  }

  const target = snapshot.second?.targetBitrate;
  if (target !== undefined && target > profile.maxBitrate * 1.05) {
    issues.push({ code: 'target-bitrate', message: `encoder mirando ${kbps(target)}, acima do teto de ${kbps(profile.maxBitrate)}` });
  }

  let measuredBitrate: number | undefined;
  const { first, second } = snapshot;
  if (first !== undefined && second !== undefined && second.timestamp > first.timestamp) {
    measuredBitrate = ((second.bytesSent - first.bytesSent) * 8 * 1000) / (second.timestamp - first.timestamp);
    // Sem saber o codec em uso, vale o que o perfil diz sobre RED.
    const redOnWire = sending === undefined ? profile.red : sendingRed;
    const allowed = profile.maxBitrate * (redOnWire ? 2 : 1) * MEASURE_TOLERANCE;
    if (measuredBitrate > allowed) {
      issues.push({ code: 'overspend', message: `saindo ${kbps(measuredBitrate)}, acima do que o perfil permite (${kbps(allowed)})` });
    }
  }

  return { ok: issues.length === 0, issues, measuredBitrate };
}

/** Uma linha para o console: o que está saindo, e o que diverge do perfil. */
export function describeAudit(label: string, audit: AudioAudit, profile: AudioSendProfile): string {
  const measured = audit.measuredBitrate === undefined ? '' : ` · medido ${Math.round(audit.measuredBitrate / 1000)} kbps`;
  const head = `[áudio] ${label}: Opus ${profile.maxBitrate / 1000} kbps${profile.stereo ? ' estéreo' : ' mono'}${profile.red ? ' + RED' : ''}${profile.dtx ? ' + DTX' : ''}${measured}`;
  return audit.ok ? `${head} — conforme o perfil` : `${head} — DIVERGE: ${audit.issues.map((issue) => issue.message).join('; ')}`;
}
