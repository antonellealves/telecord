/**
 * Configuração do serviço, lida uma vez no boot.
 *
 * Falha cedo e de uma vez só: se faltarem três variáveis, a mensagem lista as
 * três. Descobrir a segunda depois de corrigir a primeira é o que transforma
 * um deploy em meia hora de tentativa e erro.
 *
 * O Google é opcional de propósito. Sem as credenciais o serviço sobe e o
 * login por senha funciona; só a rota social responde 503 e o botão some da
 * tela (ver `GET /auth/providers`). Isso permite subir a API antes de ter o
 * OAuth Client criado no Google Cloud.
 */

export type CookieSameSite = 'lax' | 'none';
export type MailDriver = 'log' | 'resend';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

export interface AppConfig {
  port: number;
  /** Origem da SPA. Vale como allowlist de CORS e destino dos redirects. */
  appUrl: string;
  /** URL pública deste serviço. Compõe o `redirect_uri` do OAuth. */
  apiUrl: string;
  databaseUrl: string;

  jwtPrivateKey: string;
  jwtPublicKey: string;
  accessTtlSeconds: number;
  refreshTtlDays: number;

  cookieSameSite: CookieSameSite;
  cookieDomain: string | undefined;
  /** Fora de `localhost` o cookie é sempre `Secure`. */
  cookieSecure: boolean;

  google: GoogleConfig | null;

  mailDriver: MailDriver;
  mailFrom: string;
  resendApiKey: string | undefined;
}

class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, name: string, missing: string[]): string {
  const value = env[name]?.trim() ?? '';
  if (value === '') {
    missing.push(name);
    return '';
  }
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

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Desfaz o `
` literal do PEM.
 *
 * Vercel, Fly e Railway guardam variável de ambiente numa linha só, então a
 * chave chega com a barra-n escrita, não com quebra de linha. O `jose` recusa
 * PEM assim, e a falha só apareceria na primeira tentativa de login.
 */
function readPem(value: string): string {
  return value.replace(/\\n/g, '\n');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const missing: string[] = [];

  const appUrl = trimTrailingSlash(required(env, 'APP_URL', missing));
  const apiUrl = trimTrailingSlash(required(env, 'API_URL', missing));
  const databaseUrl = required(env, 'DATABASE_URL', missing);
  const jwtPrivateKey = required(env, 'AUTH_JWT_PRIVATE_KEY', missing);
  const jwtPublicKey = required(env, 'AUTH_JWT_PUBLIC_KEY', missing);

  if (missing.length > 0) {
    throw new ConfigError(
      `Faltam variáveis de ambiente: ${missing.join(', ')}. Veja .env.example.`,
    );
  }

  const sameSiteRaw = (env.AUTH_COOKIE_SAMESITE?.trim() ?? 'lax').toLowerCase();
  if (sameSiteRaw !== 'lax' && sameSiteRaw !== 'none') {
    throw new ConfigError(`AUTH_COOKIE_SAMESITE aceita "lax" ou "none" (valor: ${sameSiteRaw}).`);
  }

  const mailDriverRaw = (env.MAIL_DRIVER?.trim() ?? 'log').toLowerCase();
  if (mailDriverRaw !== 'log' && mailDriverRaw !== 'resend') {
    throw new ConfigError(`MAIL_DRIVER aceita "log" ou "resend" (valor: ${mailDriverRaw}).`);
  }
  const resendApiKey = env.RESEND_API_KEY?.trim() ?? '';
  if (mailDriverRaw === 'resend' && resendApiKey === '') {
    throw new ConfigError('MAIL_DRIVER=resend exige RESEND_API_KEY.');
  }

  const googleClientId = env.GOOGLE_CLIENT_ID?.trim() ?? '';
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET?.trim() ?? '';
  if ((googleClientId === '') !== (googleClientSecret === '')) {
    // Metade da credencial é sempre engano de configuração, e o sintoma seria
    // um 500 no meio do fluxo de login em vez de uma falha no boot.
    throw new ConfigError('GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET vão juntos ou nenhum dos dois.');
  }

  const secureCookie = !appUrl.startsWith('http://localhost');
  if (sameSiteRaw === 'none' && !secureCookie) {
    throw new ConfigError('AUTH_COOKIE_SAMESITE=none exige HTTPS; em localhost use "lax".');
  }

  return {
    port: integer(env, 'PORT', 3000),
    appUrl,
    apiUrl,
    databaseUrl,
    jwtPrivateKey: readPem(jwtPrivateKey),
    jwtPublicKey: readPem(jwtPublicKey),
    accessTtlSeconds: integer(env, 'AUTH_ACCESS_TTL_SECONDS', 900),
    refreshTtlDays: integer(env, 'AUTH_REFRESH_TTL_DAYS', 30),
    cookieSameSite: sameSiteRaw,
    cookieDomain: env.AUTH_COOKIE_DOMAIN?.trim() || undefined,
    cookieSecure: secureCookie,
    google:
      googleClientId === ''
        ? null
        : { clientId: googleClientId, clientSecret: googleClientSecret },
    mailDriver: mailDriverRaw,
    mailFrom: env.MAIL_FROM?.trim() || 'Telecord <nao-responda@localhost>',
    resendApiKey: resendApiKey === '' ? undefined : resendApiKey,
  };
}

export const CONFIG = 'APP_CONFIG';
