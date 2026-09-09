/**
 * Configuração vinda do build (SPEC §7).
 * Só variáveis VITE_* existem aqui — e tudo aqui é público.
 */

import { LIVEKIT_HOST } from '@telecord/shared';

/**
 * URL do servidor LiveKit deste projeto.
 *
 * Fica versionada porque é pública por natureza: o navegador precisa dela para
 * conectar e ela acaba dentro do bundle de qualquer forma. Versionar elimina o
 * erro clássico de esquecer a variável de build e publicar um app que não
 * conecta. `VITE_LIVEKIT_URL` continua tendo precedência, para apontar para
 * outro servidor (self-host, staging) sem tocar no código.
 *
 * Isto NÃO vale para a key e o secret: esses são lidos só pela função
 * serverless, a partir do ambiente, e nunca podem ser versionados.
 */
const DEFAULT_LIVEKIT_URL = `wss://${LIVEKIT_HOST}`;

const configuredLivekitUrl = import.meta.env.VITE_LIVEKIT_URL?.trim() ?? '';

export const LIVEKIT_URL: string =
  configuredLivekitUrl === '' ? DEFAULT_LIVEKIT_URL : configuredLivekitUrl;

export const TOKEN_ENDPOINT: string = import.meta.env.VITE_TOKEN_ENDPOINT ?? '/api/token';
export const ROOMS_ENDPOINT = '/api/rooms';

export function getConfigError(): string | null {
  if (LIVEKIT_URL === '') {
    return 'Nenhuma URL de servidor LiveKit configurada.';
  }
  if (!LIVEKIT_URL.startsWith('wss://') && !LIVEKIT_URL.startsWith('ws://')) {
    return `VITE_LIVEKIT_URL precisa começar com wss:// (valor atual: ${LIVEKIT_URL}).`;
  }
  return null;
}
