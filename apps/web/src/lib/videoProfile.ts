/**
 * Perfil de captura e publicação de VÍDEO em qualidade máxima.
 *
 * Mesmo princípio de `audioProfile.ts`: o telecord não grava nada, só
 * retransmite, então não há custo de armazenamento para justificar
 * compressão agressiva. O orçamento é CPU de quem publica e banda — os dois
 * gastos de propósito.
 *
 * As camadas precisam concordar, senão a mais restritiva vence:
 * 1. CAPTURA (aqui) — o que o navegador entrega antes de codificar.
 * 2. CODEC (`MEDIA_CODECS` em `apps/mediasoup-sfu/src/rooms.ts`) — AV1 > VP9
 *    > H.264 > VP8, nessa ordem de preferência.
 * 3. ENVIO (aqui) — o teto real no `RTCRtpSender`, que é quem manda de fato.
 */
import { screenQuality, type ScreenQualityId } from './media';

/**
 * Constraints de captura de TELA para `getDisplayMedia`.
 *
 * ## Por que não reusa `screenShareCaptureOptions` de `lib/media.ts`
 *
 * Aquela função devolve `ScreenShareCaptureOptions` do **livekit-client**:
 * um objeto com `resolution`/`contentHint` no TOPO, que só faz sentido
 * para `room.localParticipant.createScreenTracks()` — o SDK traduz aqueles
 * campos para constraints de verdade antes de chamar o navegador.
 *
 * O caminho mediasoup passa o objeto direto para `navigator.mediaDevices
 * .getDisplayMedia()`, que NÃO conhece esses campos e simplesmente os
 * ignora — sem `video`, sem resolução, sem frame rate pedido. Na prática a
 * tela era capturada no padrão do navegador (frequentemente 30 fps e
 * resolução reduzida) por mais alto que fosse o nível escolhido na UI.
 */
export function screenCaptureConstraints(quality: ScreenQualityId): DisplayMediaStreamOptions {
  const option = screenQuality(quality);
  return {
    video: {
      // `ideal`, nunca `exact`: um monitor 1600×900 não entrega 1080 de
      // altura, e `exact` ali não degrada — FALHA, e a pessoa clica em
      // compartilhar e não sai nada. O nível "máxima" tem width 0 ("não
      // redimensione") e aí nada de resolução é pedido: vem a nativa.
      ...(option.width > 0
        ? { width: { ideal: option.width }, height: { ideal: option.height } }
        : {}),
      frameRate: { ideal: option.fps, max: option.fps },
    },
    // Áudio da aba sem processamento de voz: AEC/NS/AGC destruiriam música
    // e efeito sonoro, que é justamente o conteúdo aqui.
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
      sampleRate: { ideal: 48_000 },
    },
    // Não oferece a própria aba do telecord como opção (evita o efeito
    // "túnel infinito") e deixa trocar de janela sem reabrir o seletor.
    ...({
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: 'exclude',
    } as Record<string, unknown>),
  };
}

/** Captura de CÂMERA: 1080p60 pedido como ideal, degradando sozinho se a webcam não der. */
export const CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  frameRate: { ideal: 60, min: 24 },
  facingMode: 'user',
};

/**
 * Encoding de envio da TELA.
 *
 * Uma camada só (sem simulcast): tela compartilhada é assistida em quadro
 * grande, e simulcast dividiria o mesmo orçamento de banda entre várias
 * resoluções — pagando qualidade da camada de topo por camadas que quase
 * ninguém assiste.
 *
 * `scaleResolutionDownBy: 1` é explícito de propósito: sem isto o Chrome se
 * dá liberdade de reduzir a resolução sozinho quando a CPU aperta, que é
 * exatamente o que `contentHint`/`degradationPreference` abaixo tentam
 * impedir.
 */
export function screenSendEncoding(quality: ScreenQualityId): RTCRtpEncodingParameters {
  const option = screenQuality(quality);
  return {
    maxBitrate: option.bitrate,
    maxFramerate: option.fps,
    scaleResolutionDownBy: 1,
    priority: 'high',
    networkPriority: 'high',
  };
}

/**
 * Encoding de envio da CÂMERA.
 *
 * 8 Mbps é muito acima do que videoconferência usa (o padrão fica em
 * ~1-2.5 Mbps) — é o que separa rosto com pele e textura de rosto com
 * blocos de compressão no movimento.
 */
export const CAMERA_SEND_ENCODING: RTCRtpEncodingParameters = {
  maxBitrate: 8_000_000,
  maxFramerate: 60,
  scaleResolutionDownBy: 1,
  priority: 'high',
  networkPriority: 'high',
};

/**
 * `contentHint` da track, aplicado depois da captura.
 *
 * Diz ao codificador O QUE SACRIFICAR quando aperta:
 * - `'detail'` (tela): prefere perder QUADRO a perder pixel. Para texto é a
 *   troca certa — letra borrada é ilegível, 45 fps em vez de 60 ninguém nota.
 * - `'motion'` (câmera): o oposto. Rosto fluido importa mais que nitidez de
 *   fundo, e travar a imagem numa conversa é pior que amaciar detalhe.
 */
export const SCREEN_CONTENT_HINT = 'detail';
export const CAMERA_CONTENT_HINT = 'motion';

/**
 * `degradationPreference` do sender — o mesmo dilema do `contentHint`, mas
 * no nível do WebRTC em vez do codec. Os dois precisam concordar: sem isto o
 * Chrome usa `balanced` e, no primeiro aperto, derruba a RESOLUÇÃO — que não
 * volta com a mesma pressa. É a causa mais comum de "abri em 1080 e virou
 * 720 no meio da apresentação".
 */
export const SCREEN_DEGRADATION: RTCDegradationPreference = 'maintain-resolution';
export const CAMERA_DEGRADATION: RTCDegradationPreference = 'maintain-framerate';
