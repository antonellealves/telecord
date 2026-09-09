import { useCallback, useEffect, useState } from 'react';
import type { TokenSuccessResponse } from '@telecord/shared';
import { requestToken } from '../lib/api';

export type TokenState =
  | { status: 'loading' }
  | { status: 'ready'; data: TokenSuccessResponse }
  | { status: 'error'; message: string };

export interface UseTokenResult {
  state: TokenState;
  retry: () => void;
}

/**
 * Busca o token em /api/token. Aborta a requisição no unmount e a cada nova
 * tentativa, então uma resposta atrasada nunca sobrescreve estado novo.
 */
export function useToken(roomId: string, displayName: string): UseTokenResult {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<TokenState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });

    requestToken(roomId, displayName, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setState({ status: 'ready', data });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Falha desconhecida ao obter acesso.',
        });
      });

    return () => controller.abort();
  }, [roomId, displayName, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return { state, retry };
}
