/**
 * `setCodecPreferences` para deixar só o Opus numa seção de áudio.
 *
 * Sem isto o Chrome oferece, junto com o Opus, RED, G722, PCMU, PCMA, CN e
 * telephone-event — nenhum deles usado pela voz. O servidor acaba escolhendo
 * o Opus de qualquer jeito, mas a seção fica com codec de sobra que ninguém
 * deveria poder escolher (e o RED, em particular, dobra o custo da voz).
 */

type CodecLike = Pick<RTCRtpCodec, 'mimeType' | 'clockRate' | 'channels' | 'sdpFmtpLine'>;

/** Só o Opus de 48 kHz da lista, na ordem em que veio. */
export function opusOnlyCodecs<T extends CodecLike>(codecs: readonly T[]): T[] {
  return codecs.filter((codec) => codec.mimeType.toLowerCase() === 'audio/opus' && codec.clockRate === 48_000);
}

/**
 * Aplica num transceiver de áudio. `false` quando o navegador não tem a API
 * ou recusou — a voz continua funcionando, só com a lista padrão de codecs.
 */
export function preferOpusOnly(transceiver: RTCRtpTransceiver): boolean {
  if (typeof transceiver.setCodecPreferences !== 'function') return false;
  // A especificação valida contra as capacidades de RECEPÇÃO; o Opus está
  // nas duas, então a de recepção serve para envio e recepção.
  const capabilities =
    (typeof RTCRtpReceiver !== 'undefined' ? RTCRtpReceiver.getCapabilities?.('audio') : null) ??
    (typeof RTCRtpSender !== 'undefined' ? RTCRtpSender.getCapabilities?.('audio') : null);
  const opus = opusOnlyCodecs(capabilities?.codecs ?? []);
  if (opus.length === 0) return false;
  try {
    transceiver.setCodecPreferences(opus);
    return true;
  } catch {
    return false;
  }
}
