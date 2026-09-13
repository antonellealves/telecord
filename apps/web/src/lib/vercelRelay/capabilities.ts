/**
 * O Vercel Relay depende de WebCodecs, que só existe em navegador moderno
 * baseado em Chromium (e Safari recente). Sem fallback silencioso de baixa
 * qualidade: a tela DIZ que não dá e manda usar Chrome/Edge — SPEC §20.
 */

export interface RelayCapabilities {
  videoEncoder: boolean;
  videoDecoder: boolean;
  getDisplayMedia: boolean;
  offscreenCanvas: boolean;
  webSocket: boolean;
}

export function detectRelayCapabilities(): RelayCapabilities {
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  return {
    videoEncoder: typeof VideoEncoder !== 'undefined',
    videoDecoder: typeof VideoDecoder !== 'undefined',
    getDisplayMedia: media !== undefined && typeof media.getDisplayMedia === 'function',
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    webSocket: typeof WebSocket !== 'undefined',
  };
}

/** O mínimo para publicar OU assistir. `offscreenCanvas` é preferência, não regra. */
export function isRelaySupported(caps: RelayCapabilities = detectRelayCapabilities()): boolean {
  return caps.videoEncoder && caps.videoDecoder && caps.getDisplayMedia && caps.webSocket;
}

export const UNSUPPORTED_MESSAGE =
  'Seu navegador não suporta o streaming HD experimental. Use Chrome ou Edge atualizado.';
