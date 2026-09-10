/**
 * Cliente do serviço de autenticação.
 *
 * O access token vive só em memória neste módulo. Não vai para `localStorage`:
 * qualquer XSS lê `localStorage`, e um token de 15 minutos guardado lá é um
 * token de 15 minutos entregue. O que sobrevive a recarregar a página é o
 * cookie de refresh, que é `httpOnly` e o JavaScript não alcança — no boot a
 * SPA troca esse cookie por um access novo em `/auth/refresh`.
 *
 * Com `AUTH_API_URL` vazia o módulo inteiro vira inerte e nenhuma requisição
 * sai. É o que mantém o app publicado hoje funcionando igual enquanto o
 * serviço de autenticação não existir (PLANO.md §6).
 */
import type { AuthSessionResponse, AuthUser } from '@telecord/shared';
import { AUTH_API_URL } from './config';

export const isAuthConfigured = AUTH_API_URL !== '';

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let accessToken: string | null = null;

/*
 * Uma renovação por vez.
 *
 * Sem isto, três requisições que expiram juntas disparam três `/auth/refresh`
 * em paralelo — e como o refresh ROTACIONA, a segunda apresentaria um token já
 * substituído, o servidor leria como reuso e derrubaria a sessão inteira. A
 * promessa compartilhada faz as três esperarem a mesma renovação.
 */
let pendingRefresh: Promise<AuthSessionResponse | null> | null = null;

async function readError(response: Response): Promise<AuthError> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
    const code = typeof body.error?.code === 'string' ? body.error.code : 'erro';
    const message =
      typeof body.error?.message === 'string' ? body.error.message : 'Não deu para completar.';
    return new AuthError(code, message);
  } catch {
    return new AuthError('erro', 'Não deu para falar com o servidor.');
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${AUTH_API_URL}${path}`, {
    ...init,
    // Sem isto o cookie de refresh não viaja: a API está noutra origem.
    credentials: 'include',
    headers: {
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

function remember(session: AuthSessionResponse): AuthSessionResponse {
  accessToken = session.accessToken;
  return session;
}

export async function refreshSession(): Promise<AuthSessionResponse | null> {
  if (!isAuthConfigured) return null;
  if (pendingRefresh !== null) return pendingRefresh;

  pendingRefresh = call<AuthSessionResponse>('/auth/refresh', { method: 'POST' })
    .then(remember)
    .catch(() => {
      // Sem sessão é o estado normal de quem nunca entrou. Não é erro para
      // mostrar na tela.
      accessToken = null;
      return null;
    })
    .finally(() => {
      pendingRefresh = null;
    });

  return pendingRefresh;
}

/**
 * Requisição autenticada, com uma renovação automática.
 *
 * Uma só: se a segunda tentativa também der 401, a sessão acabou de verdade e
 * insistir viraria laço.
 */
export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = (): Promise<Response> =>
    fetch(`${AUTH_API_URL}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(accessToken === null ? {} : { Authorization: `Bearer ${accessToken}` }),
        ...init.headers,
      },
    });

  const first = await send();
  if (first.status !== 401) return first;

  const renewed = await refreshSession();
  if (renewed === null) return first;
  return send();
}

/** Para `POST /api/token`: quem tem sessão entra na sala com a identidade da conta. */
export function currentAccessToken(): string | null {
  return accessToken;
}

export async function login(email: string, password: string): Promise<AuthSessionResponse> {
  return remember(
    await call<AuthSessionResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  );
}

export async function register(
  email: string,
  password: string,
  displayName: string,
): Promise<AuthSessionResponse> {
  return remember(
    await call<AuthSessionResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName }),
    }),
  );
}

export async function forgotPassword(email: string): Promise<void> {
  await call<{ ok: true }>('/auth/password/forgot', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export async function resetPassword(token: string, password: string): Promise<void> {
  await call<{ ok: true }>('/auth/password/reset', {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  });
}

export async function logout(): Promise<void> {
  accessToken = null;
  if (!isAuthConfigured) return;
  try {
    await call<void>('/auth/logout', { method: 'POST' });
  } catch {
    // Já saiu localmente. Cookie que sobrou expira sozinho, e insistir aqui só
    // prenderia a pessoa numa tela de "saindo…".
  }
}

export async function fetchProviders(): Promise<{ password: boolean; google: boolean }> {
  if (!isAuthConfigured) return { password: false, google: false };
  try {
    return await call<{ password: boolean; google: boolean }>('/auth/providers');
  } catch {
    return { password: false, google: false };
  }
}

/**
 * Navegação de página inteira, não `fetch`: o fluxo de código do OAuth precisa
 * que o NAVEGADOR vá ao Google, para a pessoa ver o domínio na barra de
 * endereço e o Google poder mostrar as contas já logadas.
 */
export function startGoogleLogin(): void {
  window.location.href = `${AUTH_API_URL}/auth/google`;
}

export type { AuthUser };
