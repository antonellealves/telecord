import { useEffect, useState } from 'react';
import type { RoomSummary } from '@telecord/shared';
import { isAuthConfigured } from '../lib/auth';
import { fetchDirectory } from '../lib/rooms';

export interface RoomDirectory {
  /** Salas nomeadas, por slug. Vazio quando não há serviço de contas. */
  bySlug: Map<string, RoomSummary>;
  rooms: RoomSummary[];
}

const EMPTY: RoomDirectory = { bySlug: new Map(), rooms: [] };

/**
 * O diretório de salas nomeadas, para a tela inicial.
 *
 * Complementa `useActiveRooms`, que pergunta ao LiveKit quem está ONLINE
 * agora. As duas fontes respondem coisas diferentes e nenhuma substitui a
 * outra: o SFU sabe quem está conversando neste instante mas só conhece o
 * slug; o banco sabe que `dota-teleton` se chama "Dota da madrugada" mas não
 * sabe se tem alguém lá.
 *
 * Falha em silêncio, de propósito. Se a API cair, a tela inicial volta a
 * mostrar exatamente o que mostrava antes desta tabela existir — slugs e
 * contagem de gente —, e ninguém deixa de entrar numa sala por causa disso.
 */
export function useRoomDirectory(): RoomDirectory {
  const [directory, setDirectory] = useState<RoomDirectory>(EMPTY);

  useEffect(() => {
    if (!isAuthConfigured) return undefined;
    const controller = new AbortController();

    void fetchDirectory(undefined, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setDirectory({
          rooms: page.items,
          bySlug: new Map(page.items.map((room) => [room.slug, room])),
        });
      })
      .catch(() => {
        // Sem diretório a tela funciona igual. Nada a dizer a quem olha.
      });

    return () => controller.abort();
  }, []);

  return directory;
}
