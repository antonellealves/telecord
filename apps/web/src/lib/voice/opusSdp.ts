/**
 * Munging do Opus no SDP — funções puras, sem DOM e sem biblioteca de SDP.
 *
 * Existe para os pontos em que a biblioteca de WebRTC não deixa configurar o
 * Opus pela API: a linha `a=fmtp` do Opus, os `a=rtcp-fb` dele e a lista de
 * codecs da seção de áudio. Trabalha texto a texto, mexendo SÓ nas linhas do
 * Opus das seções `m=audio` pedidas; o resto do SDP sai byte a byte igual.
 */

/** Parâmetros de uma linha `a=fmtp`, na ordem em que aparecem. */
export type FmtpParams = Map<string, string>;

export function parseFmtpParams(config: string): FmtpParams {
  const params: FmtpParams = new Map();
  for (const entry of config.split(';')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) params.set(trimmed.toLowerCase(), '');
    else params.set(trimmed.slice(0, eq).trim().toLowerCase(), trimmed.slice(eq + 1).trim());
  }
  return params;
}

export function formatFmtpParams(params: FmtpParams): string {
  return [...params].map(([key, value]) => (value === '' ? key : `${key}=${value}`)).join(';');
}

export interface OpusFmtpOptions {
  /** Parâmetros que a linha do Opus passa a ter (sobrescrevem os que existirem). */
  params: Readonly<Record<string, string | number>>;
  /**
   * `true`: a linha fica SÓ com `params` (mais o que `keep` aprovar).
   * `false` (padrão): mescla com o que já estava.
   */
  exact?: boolean;
  /** No modo `exact`, quais parâmetros que já estavam sobrevivem. */
  keep?: (key: string, value: string) => boolean;
  /** Parâmetros a apagar (vale nos dois modos). */
  remove?: readonly string[];
  /** `a=rtcp-fb` que o Opus precisa ter, ex.: `['nack', 'transport-cc']`. */
  rtcpFeedback?: readonly string[];
  /** Tira da seção todo codec de áudio que não seja Opus (G722, PCMU, CN, telephone-event, RED…). */
  opusOnly?: boolean;
  /** Só as seções com estes `a=mid`. Ausente: toda seção `m=audio` com Opus. */
  mids?: Iterable<string>;
}

interface Section {
  lines: string[];
}

const RTPMAP = /^a=rtpmap:(\d+)\s+([^/\s]+)\//i;

function opusPayloads(lines: readonly string[]): string[] {
  const payloads: string[] = [];
  for (const line of lines) {
    const match = RTPMAP.exec(line);
    if (match !== null && match[2]!.toLowerCase() === 'opus') payloads.push(match[1]!);
  }
  return payloads;
}

function sectionMid(lines: readonly string[]): string | null {
  const line = lines.find((entry) => entry.startsWith('a=mid:'));
  return line === undefined ? null : line.slice('a=mid:'.length).trim();
}

/** A linha pertence ao payload `pt` (rtpmap, fmtp ou rtcp-fb dele)? */
function payloadOf(line: string): string | null {
  const match = /^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)[\s]/.exec(line);
  return match === null ? null : match[1]!;
}

function rewriteFmtp(current: FmtpParams, options: OpusFmtpOptions): FmtpParams {
  const next: FmtpParams = new Map();
  if (options.exact === true) {
    for (const [key, value] of Object.entries(options.params)) next.set(key.toLowerCase(), String(value));
    for (const [key, value] of current) {
      if (!next.has(key) && options.keep?.(key, value) === true) next.set(key, value);
    }
  } else {
    for (const [key, value] of current) next.set(key, value);
    for (const [key, value] of Object.entries(options.params)) next.set(key.toLowerCase(), String(value));
  }
  for (const key of options.remove ?? []) next.delete(key.toLowerCase());
  return next;
}

function mungeSection(section: Section, options: OpusFmtpOptions): void {
  let lines = section.lines;
  const opus = opusPayloads(lines);
  if (opus.length === 0) return;

  if (options.opusOnly === true) {
    const keep = new Set(opus);
    lines = lines.filter((line) => {
      const pt = payloadOf(line);
      return pt === null || keep.has(pt);
    });
    const [mLine] = lines;
    if (mLine !== undefined) {
      const parts = mLine.split(' ');
      // m=audio <porta> <protocolo> <pt> <pt>...
      lines[0] = [...parts.slice(0, 3), ...parts.slice(3).filter((pt) => keep.has(pt))].join(' ');
    }
  }

  for (const pt of opus) {
    const fmtpIndex = lines.findIndex((line) => line.startsWith(`a=fmtp:${pt} `));
    const current = fmtpIndex === -1 ? new Map() : parseFmtpParams(lines[fmtpIndex]!.slice(`a=fmtp:${pt} `.length));
    const fmtpLine = `a=fmtp:${pt} ${formatFmtpParams(rewriteFmtp(current, options))}`;
    let anchor: number;
    if (fmtpIndex === -1) {
      anchor = lines.findIndex((line) => line.startsWith(`a=rtpmap:${pt} `));
      lines.splice(anchor + 1, 0, fmtpLine);
      anchor += 1;
    } else {
      lines[fmtpIndex] = fmtpLine;
      anchor = fmtpIndex;
    }

    for (const feedback of options.rtcpFeedback ?? []) {
      const wanted = `a=rtcp-fb:${pt} ${feedback}`;
      if (lines.includes(wanted)) continue;
      // Depois do último rtcp-fb deste payload, ou logo depois do rtpmap/fmtp.
      let insertAt = anchor;
      lines.forEach((line, index) => {
        if (line.startsWith(`a=rtcp-fb:${pt} `)) insertAt = Math.max(insertAt, index);
      });
      lines.splice(insertAt + 1, 0, wanted);
    }
  }
  section.lines = lines;
}

/**
 * Reescreve o Opus das seções de áudio de um SDP.
 *
 * Seção sem Opus, seção de vídeo e seção fora de `mids` passam intactas.
 * Idempotente: aplicar duas vezes dá o mesmo SDP que aplicar uma.
 */
export function mungeOpusFmtp(sdp: string, options: OpusFmtpOptions): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const trailing = sdp.endsWith(eol);
  const allLines = sdp.split(eol);
  if (trailing) allLines.pop();

  const head: string[] = [];
  const sections: Section[] = [];
  for (const line of allLines) {
    if (line.startsWith('m=')) sections.push({ lines: [line] });
    else if (sections.length === 0) head.push(line);
    else sections[sections.length - 1]!.lines.push(line);
  }

  const mids = options.mids === undefined ? null : new Set(options.mids);
  for (const section of sections) {
    if (!section.lines[0]!.startsWith('m=audio ')) continue;
    if (mids !== null) {
      const mid = sectionMid(section.lines);
      if (mid === null || !mids.has(mid)) continue;
    }
    mungeSection(section, options);
  }

  const out = [...head, ...sections.flatMap((section) => section.lines)].join(eol);
  return trailing ? out + eol : out;
}

/** O que o Opus de uma seção negocia — para teste e para o painel de debug. */
export interface OpusSectionInfo {
  mid: string | null;
  payloadType: number;
  fmtp: FmtpParams;
  rtcpFeedback: string[];
  /** Todos os payload types da linha `m=`. */
  payloads: number[];
}

export function readOpusSections(sdp: string): OpusSectionInfo[] {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const result: OpusSectionInfo[] = [];
  let lines: string[] | null = null;
  const flush = (): void => {
    if (lines === null || !lines[0]!.startsWith('m=audio ')) return;
    const [pt] = opusPayloads(lines);
    if (pt === undefined) return;
    const fmtp = lines.find((line) => line.startsWith(`a=fmtp:${pt} `));
    result.push({
      mid: sectionMid(lines),
      payloadType: Number(pt),
      fmtp: parseFmtpParams(fmtp === undefined ? '' : fmtp.slice(`a=fmtp:${pt} `.length)),
      rtcpFeedback: lines
        .filter((line) => line.startsWith(`a=rtcp-fb:${pt} `))
        .map((line) => line.slice(`a=rtcp-fb:${pt} `.length)),
      payloads: lines[0]!.split(' ').slice(3).map(Number),
    });
  };
  for (const line of sdp.split(eol)) {
    if (line.startsWith('m=')) {
      flush();
      lines = [line];
    } else if (lines !== null && line !== '') {
      lines.push(line);
    }
  }
  flush();
  return result;
}
