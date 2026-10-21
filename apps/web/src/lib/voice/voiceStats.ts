/**
 * Leitura do `getStats()` de UM fluxo de voz, nos mesmos campos que se olha
 * no `chrome://webrtc-internals` do Discord para comparar.
 *
 * Puro: recebe dois retratos do relatório (o atual e o de ~1 s antes) e
 * devolve números. Quem chama (o painel de debug) cuida do `getStats` e do
 * relógio.
 */

export interface StatsRecord {
  id: string;
  type: string;
  timestamp: number;
  [key: string]: unknown;
}

export type StatsMap = ReadonlyMap<string, StatsRecord>;

export function toStatsMap(report: RTCStatsReport): StatsMap {
  const map = new Map<string, StatsRecord>();
  report.forEach((value: StatsRecord, key: string) => map.set(key, value));
  return map;
}

export type VoiceDirection = 'send' | 'recv';

export interface VoiceStreamStats {
  direction: VoiceDirection;
  /** Como o webrtc-internals escreve: `opus (111, minptime=10;usedtx=1;useinbandfec=1)`. */
  codec: string | null;
  sdpFmtpLine: string | null;
  /** Payload em bits/s — o mesmo `bytesSent_in_bits/s` do webrtc-internals. */
  bitrateBps: number | null;
  /** Com cabeçalho RTP — o que a rede de fato carrega. */
  wireBitrateBps: number | null;
  packetsPerSecond: number | null;
  targetBitrate: number | null;
  packetsLost: number | null;
  /** 0..1. No envio, o que o servidor relata; na recepção, medido no intervalo. */
  fractionLost: number | null;
  jitterMs: number | null;
  rttMs: number | null;
  fecPacketsReceived: number | null;
  /** NACKs recebidos (envio) ou mandados (recepção). */
  nackCount: number | null;
  retransmittedPackets: number | null;
  /** `concealedSamples − silentConcealedSamples`, acumulado. */
  concealedNonSilentSamples: number | null;
  /** O mesmo, no intervalo, em % das amostras recebidas. */
  concealmentPercent: number | null;
  /** `jitterBufferDelay / jitterBufferEmittedCount`, em ms (no intervalo, quando dá). */
  jitterBufferMs: number | null;
  /** Nível da fonte (envio) ou do que chega (recepção), 0..1. */
  audioLevel: number | null;
}

function num(record: StatsRecord | undefined, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(record: StatsRecord | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' ? value : null;
}

function isAudio(record: StatsRecord): boolean {
  return record.kind === 'audio' || record.mediaType === 'audio';
}

function findFirst(stats: StatsMap, predicate: (record: StatsRecord) => boolean): StatsRecord | undefined {
  for (const record of stats.values()) if (predicate(record)) return record;
  return undefined;
}

/** Por segundo, entre duas leituras do mesmo contador. */
function rate(current: StatsRecord, previous: StatsRecord | undefined, key: string): number | null {
  const now = num(current, key);
  const before = num(previous, key);
  if (now === null || before === null || previous === undefined) return null;
  const seconds = (current.timestamp - previous.timestamp) / 1000;
  if (seconds <= 0) return null;
  return Math.max(0, (now - before) / seconds);
}

function delta(current: StatsRecord, previous: StatsRecord | undefined, key: string): number | null {
  const now = num(current, key);
  const before = num(previous, key);
  return now === null || before === null ? null : now - before;
}

export function codecLabel(codec: StatsRecord | undefined): string | null {
  const mime = str(codec, 'mimeType');
  if (mime === null) return null;
  const name = mime.split('/')[1] ?? mime;
  const payload = num(codec, 'payloadType');
  const fmtp = str(codec, 'sdpFmtpLine');
  const inside = [payload === null ? null : String(payload), fmtp === null || fmtp === '' ? null : fmtp].filter(
    (part): part is string => part !== null,
  );
  return inside.length === 0 ? name : `${name} (${inside.join(', ')})`;
}

/** RTT do par de candidatos em uso — vale para os dois sentidos. */
function candidatePairRtt(stats: StatsMap): number | null {
  const transport = findFirst(stats, (record) => record.type === 'transport');
  const selectedId = str(transport, 'selectedCandidatePairId');
  const pair =
    (selectedId === null ? undefined : stats.get(selectedId)) ??
    findFirst(stats, (record) => record.type === 'candidate-pair' && record.nominated === true && record.state === 'succeeded');
  return num(pair, 'currentRoundTripTime');
}

const toMs = (seconds: number | null): number | null => (seconds === null ? null : seconds * 1000);

function summarizeSend(current: StatsMap, previous: StatsMap | undefined): VoiceStreamStats | null {
  const outbound = findFirst(current, (record) => record.type === 'outbound-rtp' && isAudio(record));
  if (outbound === undefined) return null;
  const before = previous?.get(outbound.id);
  const remote =
    findFirst(current, (record) => record.type === 'remote-inbound-rtp' && record.localId === outbound.id) ??
    findFirst(current, (record) => record.type === 'remote-inbound-rtp' && isAudio(record));
  const codecId = str(outbound, 'codecId');
  const codec = codecId === null ? undefined : current.get(codecId);
  const sourceId = str(outbound, 'mediaSourceId');
  const source = sourceId === null ? undefined : current.get(sourceId);

  const payloadRate = rate(outbound, before, 'bytesSent');
  const headerRate = rate(outbound, before, 'headerBytesSent');

  return {
    direction: 'send',
    codec: codecLabel(codec),
    sdpFmtpLine: str(codec, 'sdpFmtpLine'),
    bitrateBps: payloadRate === null ? null : payloadRate * 8,
    wireBitrateBps: payloadRate === null ? null : (payloadRate + (headerRate ?? 0)) * 8,
    packetsPerSecond: rate(outbound, before, 'packetsSent'),
    targetBitrate: num(outbound, 'targetBitrate'),
    packetsLost: num(remote, 'packetsLost'),
    fractionLost: num(remote, 'fractionLost'),
    jitterMs: toMs(num(remote, 'jitter')),
    rttMs: toMs(num(remote, 'roundTripTime') ?? candidatePairRtt(current)),
    fecPacketsReceived: null,
    nackCount: num(outbound, 'nackCount'),
    retransmittedPackets: num(outbound, 'retransmittedPacketsSent'),
    concealedNonSilentSamples: null,
    concealmentPercent: null,
    jitterBufferMs: null,
    audioLevel: num(source, 'audioLevel'),
  };
}

function summarizeRecv(current: StatsMap, previous: StatsMap | undefined): VoiceStreamStats | null {
  const inbound = findFirst(current, (record) => record.type === 'inbound-rtp' && isAudio(record));
  if (inbound === undefined) return null;
  const before = previous?.get(inbound.id);
  const codecId = str(inbound, 'codecId');
  const codec = codecId === null ? undefined : current.get(codecId);
  const remote = findFirst(current, (record) => record.type === 'remote-outbound-rtp' && isAudio(record));

  const payloadRate = rate(inbound, before, 'bytesReceived');
  const headerRate = rate(inbound, before, 'headerBytesReceived');

  const lost = delta(inbound, before, 'packetsLost');
  const received = delta(inbound, before, 'packetsReceived');
  const fractionLost = lost === null || received === null || lost + received <= 0 ? null : Math.max(0, lost) / (lost + received);

  const concealed = num(inbound, 'concealedSamples');
  const silent = num(inbound, 'silentConcealedSamples');
  const concealedNonSilentSamples = concealed === null ? null : concealed - (silent ?? 0);
  const concealedDelta = delta(inbound, before, 'concealedSamples');
  const silentDelta = delta(inbound, before, 'silentConcealedSamples') ?? 0;
  const samplesDelta = delta(inbound, before, 'totalSamplesReceived');
  const concealmentPercent =
    concealedDelta === null || samplesDelta === null || samplesDelta <= 0
      ? null
      : (Math.max(0, concealedDelta - silentDelta) / samplesDelta) * 100;

  const bufferDelta = delta(inbound, before, 'jitterBufferDelay');
  const emittedDelta = delta(inbound, before, 'jitterBufferEmittedCount');
  const bufferTotal = num(inbound, 'jitterBufferDelay');
  const emittedTotal = num(inbound, 'jitterBufferEmittedCount');
  let jitterBufferMs: number | null = null;
  if (bufferDelta !== null && emittedDelta !== null && emittedDelta > 0) jitterBufferMs = (bufferDelta / emittedDelta) * 1000;
  else if (bufferTotal !== null && emittedTotal !== null && emittedTotal > 0) jitterBufferMs = (bufferTotal / emittedTotal) * 1000;

  return {
    direction: 'recv',
    codec: codecLabel(codec),
    sdpFmtpLine: str(codec, 'sdpFmtpLine'),
    bitrateBps: payloadRate === null ? null : payloadRate * 8,
    wireBitrateBps: payloadRate === null ? null : (payloadRate + (headerRate ?? 0)) * 8,
    packetsPerSecond: rate(inbound, before, 'packetsReceived'),
    targetBitrate: null,
    packetsLost: num(inbound, 'packetsLost'),
    fractionLost,
    jitterMs: toMs(num(inbound, 'jitter')),
    rttMs: toMs(num(remote, 'roundTripTime') ?? candidatePairRtt(current)),
    fecPacketsReceived: num(inbound, 'fecPacketsReceived'),
    nackCount: num(inbound, 'nackCount'),
    retransmittedPackets: num(inbound, 'retransmittedPacketsReceived'),
    concealedNonSilentSamples,
    concealmentPercent,
    jitterBufferMs,
    audioLevel: num(inbound, 'audioLevel'),
  };
}

export function summarizeVoiceStream(
  direction: VoiceDirection,
  current: StatsMap,
  previous?: StatsMap,
): VoiceStreamStats | null {
  return direction === 'send' ? summarizeSend(current, previous) : summarizeRecv(current, previous);
}

// ---------------------------------------------------------------------------
// DTX: o silêncio cai para ~1–2 kbps?
// ---------------------------------------------------------------------------

/** Abaixo disto a fonte está calada (≈ −40 dBFS). */
export const SILENCE_LEVEL = 0.01;
/** Acima disto, alguém está falando (≈ −30 dBFS). */
export const SPEECH_LEVEL = 0.03;
/** Silêncio acima disto quer dizer DTX desligado ou sem efeito. */
export const DTX_SILENCE_CEILING_BPS = 4_000;

const WINDOW = 10;
const MIN_SAMPLES = 3;

export type DtxVerdict = 'medindo' | 'ok' | 'dtx-inativo';

export interface DtxSummary {
  silenceBps: number | null;
  speakingBps: number | null;
  verdict: DtxVerdict;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Separa as leituras do microfone em "calado" e "falando" pelo nível da
 * fonte, e compara o bitrate de cada grupo. Exige DUAS leituras caladas
 * seguidas para contar uma: a janela de 1 s que termina em silêncio ainda
 * carrega o fim da frase anterior.
 */
export class DtxMeter {
  private readonly silent: number[] = [];
  private readonly speaking: number[] = [];
  private lastWasSilent = false;

  push(audioLevel: number | null, bitrateBps: number | null): void {
    if (audioLevel === null || bitrateBps === null) return;
    const silentNow = audioLevel < SILENCE_LEVEL;
    if (silentNow && this.lastWasSilent) this.keep(this.silent, bitrateBps);
    else if (audioLevel > SPEECH_LEVEL) this.keep(this.speaking, bitrateBps);
    this.lastWasSilent = silentNow;
  }

  private keep(list: number[], value: number): void {
    list.push(value);
    if (list.length > WINDOW) list.shift();
  }

  get summary(): DtxSummary {
    const silenceBps = median(this.silent);
    const speakingBps = median(this.speaking);
    let verdict: DtxVerdict = 'medindo';
    if (silenceBps !== null && this.silent.length >= MIN_SAMPLES) {
      verdict = silenceBps <= DTX_SILENCE_CEILING_BPS ? 'ok' : 'dtx-inativo';
    }
    return { silenceBps, speakingBps, verdict };
  }
}
