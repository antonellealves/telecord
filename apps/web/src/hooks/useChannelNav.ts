import { useEffect, useState } from 'react';
import type { ChannelDetail } from '@telecord/shared';
import { fetchChannel } from '../lib/channels';
import { fetchRoom } from '../lib/rooms';

export interface ChannelNavState {
  /** Canal ao qual a sala atual pertence, ou null se ela for avulsa. */
  channel: ChannelDetail | null;
  isLoading: boolean;
}

/**
 * Descobre se a sala atual pertence a um canal e, se sim, busca a lista de
 * salas irmãs — o que alimenta a navegação lateral "transite entre salas".
 *
 * Duas idas à API em sequência, não uma: primeiro `fetchRoom` para saber o
 * `channelSlug` (a maioria das salas não tem — é avulsa, e o hook para por
 * aí), depois `fetchChannel` só quando existir. Buscar o canal direto pelo
 * `roomId` exigiria uma rota nova (`GET /rooms/:slug/channel`) para economizar
 * uma consulta que, no caso comum, nem acontece.
 *
 * Silencioso em qualquer falha: sem navegação de canal a sala continua
 * funcionando exatamente como antes de canais existirem — API fora do ar não
 * pode impedir ninguém de estar na sala.
 */
export function useChannelNav(roomId: string): ChannelNavState {
  const [channel, setChannel] = useState<ChannelDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setChannel(null);

    void fetchRoom(roomId, controller.signal)
      .then((room) => {
        if (controller.signal.aborted) return null;
        if (room.channelSlug === null) return null;
        return fetchChannel(room.channelSlug, controller.signal);
      })
      .then((detail) => {
        if (controller.signal.aborted) return;
        setChannel(detail);
      })
      .catch(() => {
        if (!controller.signal.aborted) setChannel(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [roomId]);

  return { channel, isLoading };
}
