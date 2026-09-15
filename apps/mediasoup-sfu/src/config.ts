/**
 * Configuração do processo mediasoup-sfu, lida uma vez no boot.
 *
 * Mesmo princípio do `apps/api/src/common/config.ts`: falha cedo, com uma
 * mensagem que lista tudo que falta de uma vez.
 */

class ConfigError extends Error {}

export interface SfuConfig {
  port: number;
  /**
   * Credencial compartilhada com `apps/api`, usada de duas formas: (1) as
   * rotas `/rooms/*` deste processo exigem `Authorization: Bearer
   * <internalSecret>`, tráfego servidor-servidor via o proxy `/api/mediasoup/*`;
   * (2) o MESMO segredo assina/verifica o token de curta duração do canal
   * `/presence` (ver `presenceToken.ts` em `@telecord/shared`), que esse sim
   * é exposto ao navegador — reuso deliberado, sem segredo novo, porque
   * verificar o token não exige o Bearer completo, só recalcular o HMAC.
   */
  internalSecret: string;
  /**
   * IP público da VM, anunciado como candidato ICE. Mesma necessidade do
   * `LIVEKIT_NODE_IP` em `livekit.yaml`: sem isto, o mediasoup só anuncia o IP
   * interno do container, e nenhum cliente fora da VM consegue estabelecer o
   * caminho de mídia.
   */
  announcedIp: string;
  rtcMinPort: number;
  rtcMaxPort: number;
}

function required(env: NodeJS.ProcessEnv, name: string, missing: string[]): string {
  const value = env[name]?.trim() ?? '';
  if (value === '') missing.push(name);
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim() ?? '';
  if (raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} precisa ser um inteiro positivo (valor: ${raw}).`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SfuConfig {
  const missing: string[] = [];
  const internalSecret = required(env, 'MEDIASOUP_INTERNAL_SECRET', missing);
  const announcedIp = required(env, 'MEDIASOUP_ANNOUNCED_IP', missing);

  if (missing.length > 0) {
    throw new ConfigError(`Faltam variáveis de ambiente: ${missing.join(', ')}.`);
  }

  return {
    port: integer(env, 'PORT', 3100),
    internalSecret,
    announcedIp,
    // Faixa PRÓPRIA, fora da 40000-40100/udp que o livekit.yaml já reserva
    // nesta mesma VM — as duas faixas nunca podem se sobrepor.
    rtcMinPort: integer(env, 'MEDIASOUP_RTC_MIN_PORT', 40101),
    rtcMaxPort: integer(env, 'MEDIASOUP_RTC_MAX_PORT', 40200),
  };
}
