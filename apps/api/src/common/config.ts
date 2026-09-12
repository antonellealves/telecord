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

/**
 * Credencial do LiveKit, usada SÓ para conferir a assinatura do webhook.
 *
 * As mesmas duas variáveis que a função `api/token.ts` já lê para EMITIR
 * token. Aqui elas só verificam: o serviço não fala com o LiveKit, ele apenas
 * confirma que quem falou com ele foi o LiveKit.
 *
 * Opcional pelo mesmo motivo do Google: sem elas o serviço sobe, o webhook
 * responde 503 e o painel diz que não há dado de sessão — em vez de mostrar
 * zero como se fosse a verdade.
 */
export interface LiveKitConfig {
  apiKey: string;
  apiSecret: string;
}

/**
 * TURN para o modo direto, quando houver.
 *
 * Duas formas de credencial: ESTÁTICA (`username` + `credential` fixos) ou
 * TEMPORÁRIA (`secret` compartilhado com o TURN, e cada requisição a `/api/ice`
 * gera um usuário que expira em `ttlSeconds`). A temporária é a boa prática —
 * uma credencial que vaza do devtools de alguém morre sozinha em horas — e é o
 * formato REST do coturn e dos TURN gerenciados (Cloudflare, metered).
 */
export interface TurnConfig {
  urls: string[];
  username?: string;
  credential?: string;
  secret?: string;
  ttlSeconds: number;
}

/**
 * Servidores de gelo do modo direto.
 *
 * STUN tem default no código (o público do Google) — o modo direto funciona
 * sem configurar nada. TURN é opcional: sem serviço para hospedá-lo (a Vercel é
 * serverless e não segura UDP de longa duração), fica de fora por padrão, e a
 * malha usa só o caminho direto. Quem tiver um TURN à mão — self-host ou
 * gerenciado — aponta pelas variáveis e a travessia de NAT difícil passa a
 * funcionar, sem tocar no código.
 */
export interface IceConfig {
  stunUrls: string[];
  turn: TurnConfig | null;
}

/**
 * Cloudflare Realtime SFU (transporte 'cfsfu').
 *
 * `appId` e `appToken` NUNCA chegam ao navegador — o cliente fala com o SFU
 * através do proxy `/api/cfsfu/*`, que é quem assina as chamadas. `null` = a
 * terceira opção fica desligada (o cartão some da tela), o que é o padrão até
 * alguém configurar o app no dashboard da Cloudflare.
 */
export interface CfSfuConfig {
  appId: string;
  appToken: string;
  /** Cota mensal de egress do free tier, para o aviso e o bloqueio na UI. */
  monthlyLimitGb: number;
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
  livekit: LiveKitConfig | null;
  ice: IceConfig;
  cfsfu: CfSfuConfig | null;

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

/** Lista separada por vírgula, sem itens vazios. */
function csvList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * STUN público do Google, o padrão quando nada é configurado.
 *
 * Mais de um endereço porque STUN é barato e ter alternativas reduz a chance de
 * um deles fora do ar atrasar a descoberta do endereço externo.
 */
const DEFAULT_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
];

function loadIceConfig(env: NodeJS.ProcessEnv): IceConfig {
  const stunUrls = csvList(env.P2P_STUN_URLS);
  const turnUrls = csvList(env.P2P_TURN_URLS);

  let turn: TurnConfig | null = null;
  if (turnUrls.length > 0) {
    const username = env.P2P_TURN_USERNAME?.trim() ?? '';
    const credential = env.P2P_TURN_CREDENTIAL?.trim() ?? '';
    const secret = env.P2P_TURN_SECRET?.trim() ?? '';
    // Credencial temporária OU estática, nunca nenhuma: um TURN sem credencial
    // não autentica ninguém, e o sintoma seria conexão que nunca sobe.
    if (secret === '' && (username === '' || credential === '')) {
      throw new ConfigError(
        'P2P_TURN_URLS exige P2P_TURN_SECRET (credencial temporária) ou ' +
          'P2P_TURN_USERNAME + P2P_TURN_CREDENTIAL (estática).',
      );
    }
    turn = {
      urls: turnUrls,
      username: username === '' ? undefined : username,
      credential: credential === '' ? undefined : credential,
      secret: secret === '' ? undefined : secret,
      ttlSeconds: integer(env, 'P2P_TURN_TTL_SECONDS', 86_400),
    };
  }

  return {
    stunUrls: stunUrls.length > 0 ? stunUrls : DEFAULT_STUN_URLS,
    turn,
  };
}

/**
 * Lê a configuração do Cloudflare Realtime SFU.
 *
 * Ligado só quando `CF_REALTIME_ENABLED` é verdadeiro E há credencial. Ligado
 * sem credencial derruba o boot de propósito — meia configuração viraria um 500
 * na primeira sala, não um cartão que some. Desligado devolve `null`, e a
 * terceira opção nem aparece. Aceita os nomes `CLOUDFLARE_REALTIME_*` como
 * reserva dos `CF_REALTIME_*`.
 */
function loadCfSfuConfig(env: NodeJS.ProcessEnv): CfSfuConfig | null {
  const enabledRaw = (env.CF_REALTIME_ENABLED?.trim() ?? '').toLowerCase();
  const enabled = enabledRaw === 'true' || enabledRaw === '1' || enabledRaw === 'on';
  if (!enabled) return null;

  const appId = (env.CF_REALTIME_APP_ID ?? env.CLOUDFLARE_REALTIME_APP_ID)?.trim() ?? '';
  const appToken =
    (env.CF_REALTIME_APP_TOKEN ?? env.CLOUDFLARE_REALTIME_APP_SECRET)?.trim() ?? '';
  if (appId === '' || appToken === '') {
    throw new ConfigError(
      'CF_REALTIME_ENABLED=true exige CF_REALTIME_APP_ID e CF_REALTIME_APP_TOKEN.',
    );
  }

  return {
    appId,
    appToken,
    monthlyLimitGb: integer(env, 'CF_REALTIME_MONTHLY_GB_LIMIT', 1000),
  };
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
  /*
   * As aspas de fora, quando vierem.
   *
   * `scripts/gen-auth-keys.mjs` imprime as chaves no formato pronto para colar
   * num arquivo `.env` — `AUTH_JWT_PRIVATE_KEY="-----BEGIN…"` —, e ali as
   * aspas são delimitador do shell. Colando o valor num campo de painel
   * (Vercel, GitHub) elas viram PARTE do valor, e o `jose` recusa o PEM com um
   * "must be PKCS#8 formatted string" que não diz nada sobre aspas.
   *
   * O sintoma disso é cruel: a chave só é usada ao ASSINAR, então o serviço
   * sobe normalmente, o diretório de salas responde, o login com senha errada
   * devolve 401 certinho — e só cadastrar ou entrar de verdade quebra com 500,
   * porque só esses caminhos chegam em `signAccessToken`.
   *
   * Aspas em volta de um PEM nunca são conteúdo legítimo, então tirar é seguro
   * e não esconde erro de ninguém.
   */
  const semAspas = value.trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
  return semAspas.replace(/\\n/g, '\n');
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

  const livekitKey = env.LIVEKIT_API_KEY?.trim() ?? '';
  const livekitSecret = env.LIVEKIT_API_SECRET?.trim() ?? '';
  if ((livekitKey === '') !== (livekitSecret === '')) {
    throw new ConfigError('LIVEKIT_API_KEY e LIVEKIT_API_SECRET vão juntos ou nenhum dos dois.');
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
    livekit: livekitKey === '' ? null : { apiKey: livekitKey, apiSecret: livekitSecret },
    ice: loadIceConfig(env),
    cfsfu: loadCfSfuConfig(env),
    mailDriver: mailDriverRaw,
    mailFrom: env.MAIL_FROM?.trim() || 'Telecord <nao-responda@localhost>',
    resendApiKey: resendApiKey === '' ? undefined : resendApiKey,
  };
}

export const CONFIG = 'APP_CONFIG';
