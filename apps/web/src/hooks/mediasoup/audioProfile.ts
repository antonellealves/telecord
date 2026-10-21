import { DEFAULT_VOICE_BITRATE, type VoiceBitrate } from '../../lib/voice/voiceProfile';

/**
 * Perfil de captura e publicação de voz no transporte mediasoup — o mesmo do
 * Discord e da sala LiveKit (ver `lib/voice/voiceProfile.ts`).
 *
 * As três camadas precisam concordar, senão a mais restritiva vence:
 * 1. CAPTURA (`voiceCaptureConstraints`, em `lib/voice/voiceProfile.ts`) —
 *    processamento de voz do navegador como pedido `ideal`, aparelho pelo id
 *    exato, sem forçar taxa nem canais.
 * 2. CODEC (`MIC_CODEC_OPTIONS`, aqui, e `MEDIA_CODECS` em
 *    `apps/mediasoup-sfu/src/codecs.ts`) — o `fmtp` do Opus que o encoder
 *    recebe. `voiceDevice.ts` garante o resultado exato no SDP.
 * 3. ENVIO (`micSendEncoding`, aqui) — o teto real no `RTCRtpSender`.
 */

/**
 * Opções de codec do microfone, que o mediasoup-client escreve na resposta
 * ao `produce()`: `useinbandfec=1;usedtx=1`, mais o `minptime=10` que o
 * Router e o Chrome já têm.
 *
 * O que NÃO está aqui é de propósito:
 * - `opusStereo`: sem ele não sai `stereo` nem `sprop-stereo` no SDP. A voz é
 *   mono de fato, e quem recebe fica com o `fmtp` padrão do Chrome.
 * - `opusPtime`: quadro padrão de 20 ms, como o Discord.
 * - `opusMaxAverageBitrate`/`opusMaxPlaybackRate`: o teto vai no sender
 *   (`maxBitrate`), e 48 kHz já é o padrão do Opus.
 *
 * `opusNack` mantém o `a=rtcp-fb:111 nack`: com RTT baixo a retransmissão
 * cabe no jitter buffer e uma perda que o FEC não cobriu vira áudio íntegro.
 */
export const MIC_CODEC_OPTIONS = {
  opusFec: true,
  opusDtx: true,
  opusNack: true,
} as const;

/**
 * Encoding do `RTCRtpSender` do microfone. É ESTE valor que manda no bitrate
 * real (`targetBitrate`), e é reaplicado por `setParameters` depois do
 * `produce()` e a cada troca do teto na sala.
 */
export function micSendEncoding(bitrate: VoiceBitrate = DEFAULT_VOICE_BITRATE): RTCRtpEncodingParameters {
  return {
    maxBitrate: bitrate,
    priority: 'high',
    networkPriority: 'high',
  };
}

/**
 * Áudio da TELA compartilhada (música, vídeo, jogo) — não é voz.
 *
 * Aqui o estéreo importa de verdade (é conteúdo mixado, com imagem estéreo
 * real) e o material é muito mais exigente que fala: 320 kbps é o patamar em
 * que o Opus fica transparente para música. Sem DTX: música tem trecho baixo
 * que não é silêncio.
 */
export const SCREEN_AUDIO_TARGET_BITRATE = 320_000;

export const SCREEN_AUDIO_CODEC_OPTIONS = {
  opusStereo: true,
  opusFec: true,
  opusDtx: false,
  opusMaxPlaybackRate: 48_000,
  opusMaxAverageBitrate: SCREEN_AUDIO_TARGET_BITRATE,
  opusPtime: 20,
  opusNack: true,
} as const;

export const SCREEN_AUDIO_SEND_ENCODING: RTCRtpEncodingParameters = {
  maxBitrate: SCREEN_AUDIO_TARGET_BITRATE,
  priority: 'high',
  networkPriority: 'high',
  ...({ dtx: 'disabled' } as Record<string, unknown>),
};
