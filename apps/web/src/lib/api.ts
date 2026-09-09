import {
  isTokenErrorResponse,
  type TokenErrorCode,
  type TokenResponse,
  type TokenSuccessResponse,
} from '@telecord/shared';
import { TOKEN_ENDPOINT } from './config';

export class TokenRequestError extends Error {
  readonly code: TokenErrorCode | 'NETWORK' | 'BAD_RESPONSE';

  constructor(message: string, code: TokenErrorCode | 'NETWORK' | 'BAD_RESPONSE') {
    super(message);
    this.name = 'TokenRequestError';
    this.code = code;
  }
}

/** POST /api/token. Lança TokenRequestError com mensagem já apresentável. */
export async function requestToken(
  roomId: string,
  displayName: string,
  signal: AbortSignal,
): Promise<TokenSuccessResponse> {
  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, displayName }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    throw new TokenRequestError(
      'Não foi possível falar com o servidor. Verifique sua conexão e tente de novo.',
      'NETWORK',
    );
  }

  let payload: TokenResponse;
  try {
    payload = (await response.json()) as TokenResponse;
  } catch {
    throw new TokenRequestError(
      `O servidor respondeu ${response.status} sem um JSON válido.`,
      'BAD_RESPONSE',
    );
  }

  if (isTokenErrorResponse(payload)) {
    throw new TokenRequestError(payload.error.message, payload.error.code);
  }

  if (!response.ok) {
    throw new TokenRequestError(`O servidor respondeu ${response.status}.`, 'BAD_RESPONSE');
  }

  return payload;
}
