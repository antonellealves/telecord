import { mungeOpusFmtp } from './opusSdp';
import { OPUS_RECV_FMTP, OPUS_SEND_FMTP, VOICE_RTCP_FEEDBACK } from './voiceProfile';

/**
 * As duas regras de SDP da voz, prontas para quem tiver um ponto de munging.
 *
 * - **Envio** — vale para o SDP que diz ao NOSSO encoder como codificar: a
 *   resposta do servidor ao microfone. Deixa o Opus exatamente como o do
 *   Discord (`minptime=10;useinbandfec=1;usedtx=1`), com NACK e transport-cc,
 *   e só o Opus na seção.
 * - **Recepção** — vale para a nossa resposta às seções que recebem: o
 *   padrão do Chrome (`minptime=10;useinbandfec=1`). Só `stereo=1` sobrevive,
 *   porque o áudio da tela compartilhada chega em estéreo de verdade.
 */
export function mungeVoiceSendSdp(sdp: string, mids: Iterable<string>): string {
  return mungeOpusFmtp(sdp, {
    params: OPUS_SEND_FMTP,
    exact: true,
    rtcpFeedback: VOICE_RTCP_FEEDBACK,
    opusOnly: true,
    mids,
  });
}

export function mungeVoiceRecvSdp(sdp: string, mids?: Iterable<string>): string {
  return mungeOpusFmtp(sdp, {
    params: OPUS_RECV_FMTP,
    exact: true,
    keep: (key, value) => key === 'stereo' && value === '1',
    rtcpFeedback: VOICE_RTCP_FEEDBACK,
    mids,
  });
}
