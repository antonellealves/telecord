import { parse, serialize, type SerializeOptions } from 'cookie';
import type { Request, Response } from 'express';
import type { AppConfig } from './config';

export const REFRESH_COOKIE = 'tc_refresh';
/** Guarda `state` e `code_verifier` do PKCE entre o /auth/google e o callback. */
export const OAUTH_COOKIE = 'tc_oauth';

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) return undefined;
  return parse(header)[name];
}

function baseOptions(config: AppConfig): SerializeOptions {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: config.cookieSameSite,
    domain: config.cookieDomain,
    path: '/',
  };
}

export function setRefreshCookie(
  response: Response,
  config: AppConfig,
  token: string,
  expiresAt: Date,
): void {
  response.append(
    'Set-Cookie',
    serialize(REFRESH_COOKIE, token, { ...baseOptions(config), expires: expiresAt }),
  );
}

export function clearRefreshCookie(response: Response, config: AppConfig): void {
  response.append('Set-Cookie', serialize(REFRESH_COOKIE, '', { ...baseOptions(config), maxAge: 0 }));
}

export function setOAuthCookie(response: Response, config: AppConfig, value: string): void {
  response.append(
    'Set-Cookie',
    // Dez minutos: é o tempo de ir ao Google e voltar. Mais que isso só amplia
    // a janela em que um `state` roubado ainda serve.
    serialize(OAUTH_COOKIE, value, { ...baseOptions(config), maxAge: 600 }),
  );
}

export function clearOAuthCookie(response: Response, config: AppConfig): void {
  response.append('Set-Cookie', serialize(OAUTH_COOKIE, '', { ...baseOptions(config), maxAge: 0 }));
}
