import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { GoogleConfig } from '../common/config';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/*
 * O conjunto de chaves é buscado uma vez e cacheado pelo `jose`, que respeita o
 * cabeçalho de cache do Google e rebusca quando aparece um `kid` desconhecido.
 * Criar isto por requisição faria um GET ao Google a cada login.
 */
const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export interface GoogleIdentity {
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function createState(): string {
  return randomBytes(16).toString('base64url');
}

export function buildAuthorizeUrl(options: {
  config: GoogleConfig;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', options.config.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', options.state);
  url.searchParams.set('code_challenge', options.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Sem isto o Google pula a tela de contas para quem já está logado, e não há
  // como trocar de conta sem sair do Google inteiro.
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

class GoogleError extends Error {}

/**
 * Troca o `code` pelo `id_token` e valida a assinatura contra o JWKS do Google.
 *
 * Decodificar o `id_token` sem verificar seria aceitar qualquer JSON que
 * chegasse: o token é o que afirma quem é a pessoa, e quem o assina é o Google.
 * `aud` também é conferido — um `id_token` legítimo, emitido para OUTRO
 * aplicativo, não pode servir de login aqui.
 */
export async function exchangeCode(options: {
  config: GoogleConfig;
  redirectUri: string;
  code: string;
  verifier: string;
}): Promise<GoogleIdentity> {
  const body = new URLSearchParams({
    client_id: options.config.clientId,
    client_secret: options.config.clientSecret,
    code: options.code,
    code_verifier: options.verifier,
    grant_type: 'authorization_code',
    redirect_uri: options.redirectUri,
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    // O corpo do erro do Google repete o client_id; não vai para log nem para
    // a resposta.
    throw new GoogleError(`troca de código recusada (HTTP ${response.status})`);
  }

  const payload = (await response.json()) as { id_token?: unknown };
  if (typeof payload.id_token !== 'string') {
    throw new GoogleError('resposta sem id_token');
  }

  const { payload: claims } = await jwtVerify(payload.id_token, jwks, {
    issuer: ISSUERS,
    audience: options.config.clientId,
    algorithms: ['RS256'],
  });

  const sub = claims.sub;
  const email = claims.email;
  if (typeof sub !== 'string' || typeof email !== 'string' || email === '') {
    throw new GoogleError('id_token sem sub ou email');
  }

  return {
    providerAccountId: sub,
    email: email.toLowerCase(),
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === 'string' && claims.name !== '' ? claims.name : null,
    picture: typeof claims.picture === 'string' && claims.picture !== '' ? claims.picture : null,
  };
}
