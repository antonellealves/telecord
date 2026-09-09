/**
 * Configuração vinda do build (SPEC §7).
 * Só variáveis VITE_* existem aqui — e tudo aqui é público.
 */

export const LIVEKIT_URL: string = import.meta.env.VITE_LIVEKIT_URL ?? '';
export const TOKEN_ENDPOINT: string = import.meta.env.VITE_TOKEN_ENDPOINT ?? '/api/token';

export function getConfigError(): string | null {
  if (LIVEKIT_URL === '') {
    return 'VITE_LIVEKIT_URL não foi definida no build. Configure a URL do seu projeto LiveKit (wss://...) e faça o deploy de novo.';
  }
  if (!LIVEKIT_URL.startsWith('wss://') && !LIVEKIT_URL.startsWith('ws://')) {
    return `VITE_LIVEKIT_URL precisa começar com wss:// (valor atual: ${LIVEKIT_URL}).`;
  }
  return null;
}
