import { useCallback, useEffect, useRef, useState } from 'react';
import { isRoomsErrorResponse, type ActiveRoom, type RoomsResponse } from '@telecord/shared';
import { ROOMS_ENDPOINT } from '../lib/config';

export interface ActiveRoomsState {
  rooms: ActiveRoom[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

const POLL_MS = 15000;

/**
 * Salas ativas, do SFU.
 *
 * Recarrega sozinha a cada 15s e só quando a aba está visível — sala aberta em
 * segundo plano ficaria batendo na API do LiveKit sem ninguém olhando.
 */
export function useActiveRooms(): ActiveRoomsState {
  const [rooms, setRooms] = useState<ActiveRoom[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(ROOMS_ENDPOINT, { signal: controller.signal });
      const payload = (await response.json()) as RoomsResponse;
      if (controller.signal.aborted) return;

      if (isRoomsErrorResponse(payload)) {
        setError(payload.error.message);
        setRooms([]);
      } else {
        setError(null);
        setRooms(payload.rooms);
      }
    } catch {
      if (!controller.signal.aborted) {
        setError('Não foi possível carregar as salas agora.');
      }
    } finally {
      if (!controller.signal.aborted) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void load();

    const tick = (): void => {
      if (document.visibilityState === 'visible') {
        void load();
      }
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      abortRef.current?.abort();
    };
  }, [load]);

  return { rooms, isLoading, error, refresh: () => void load() };
}
