import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveRoom } from '@telecord/shared';
import { apiGet } from '../lib/apiClient';

export interface ActiveMediasoupRoomsState {
  rooms: LiveRoom[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

const POLL_MS = 15000;

/**
 * Salas mediasoup com gente dentro AGORA — o equivalente de `useActiveRooms`
 * (LiveKit) para o quinto transporte. Fonte é `GET /mediasoup/live-rooms`,
 * pública e sem paginação (mesmo espírito do painel "Ao vivo").
 *
 * Existe como hook separado, e não uma opção a mais em `useActiveRooms`,
 * porque as duas fontes são serviços diferentes (uma função serverless sem
 * banco para LiveKit, o Nest para mediasoup) — casar as duas na Home é
 * trabalho de quem RENDERIZA (`ActiveRoomsList`), não de quem busca.
 */
export function useActiveMediasoupRooms(): ActiveMediasoupRoomsState {
  const [rooms, setRooms] = useState<LiveRoom[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const list = await apiGet<LiveRoom[]>('/mediasoup/live-rooms', controller.signal);
      if (controller.signal.aborted) return;
      setError(null);
      setRooms(list);
    } catch {
      if (!controller.signal.aborted) {
        // Silencioso: mediasoup é opcional neste servidor (ver `MediasoupSfuClient.enabled`
        // no backend), e a Home não deveria mostrar erro por um transporte que pode nem
        // estar ligado — a lista simplesmente fica vazia, igual a "sem sala mediasoup agora".
        setRooms([]);
      }
    } finally {
      if (!controller.signal.aborted) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();

    const tick = (): void => {
      if (document.visibilityState === 'visible') void load();
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
