/**
 * Chamadas autenticadas às rotas do serviço, com erro já apresentável.
 *
 * Toda requisição passa pelo `authedFetch` do módulo de autenticação, que é
 * quem sabe do access token em memória e quem renova a sessão uma vez quando
 * ela vence no meio do caminho. Nada aqui toca em token — duplicar essa lógica
 * seria criar um segundo lugar onde a renovação pode dessincronizar e derrubar
 * a sessão inteira por reuso de refresh.
 *
 * Com `AUTH_API_URL` vazia nada é chamado: o app sem contas continua sendo o
 * estado normal, e cada tela decide o que mostrar no lugar.
 */
import { authedFetch, isAuthConfigured } from './auth';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Serviço não configurado neste build. Distinto de erro de rede. */
export const OFFLINE = new ApiError(
  'sem_servico',
  'Este ambiente está sem o serviço de contas.',
  0,
);

async function readError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
    return new ApiError(
      typeof body.error?.code === 'string' ? body.error.code : 'erro',
      typeof body.error?.message === 'string' ? body.error.message : 'Não deu para completar.',
      response.status,
    );
  } catch {
    // Resposta sem JSON: quase sempre proxy no meio, ou HTML de erro.
    return new ApiError('erro', `O servidor respondeu ${response.status}.`, response.status);
  }
}

async function send<T>(path: string, init: RequestInit): Promise<T> {
  if (!isAuthConfigured) throw OFFLINE;

  let response: Response;
  try {
    response = await authedFetch(path, init);
  } catch {
    throw new ApiError('rede', 'Não foi possível falar com o servidor.', 0);
  }

  if (!response.ok) throw await readError(response);
  // 204 é resposta legítima de quem apaga: não tem corpo para interpretar.
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return send<T>(path, signal === undefined ? {} : { signal });
}

export async function apiJson<T>(
  path: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<T> {
  return send<T>(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * Envio de arquivo: o corpo são os bytes crus, e os metadados vão na query.
 *
 * `Content-Type` genérico de propósito. O servidor não confia nele — ele
 * fareja os primeiros bytes para decidir o formato — e declarar
 * `application/octet-stream` deixa isso explícito de um lado ao outro, em vez
 * de sugerir uma promessa que ninguém verifica.
 */
export async function apiUpload<T>(path: string, bytes: ArrayBuffer): Promise<T> {
  return send<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
}

/** Monta query string pulando o que for nulo, para não mandar `?x=undefined`. */
export function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}
