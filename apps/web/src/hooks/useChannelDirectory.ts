import { useEffect, useState } from 'react';
import type { ChannelSummary } from '@telecord/shared';
import { isAuthConfigured } from '../lib/auth';
import { fetchChannelDirectory } from '../lib/channels';

export interface ChannelDirectory {
  channels: ChannelSummary[];
}

const EMPTY: ChannelDirectory = { channels: [] };

/**
 * O diretório de canais, para a tela inicial — o mesmo padrão de
 * `useRoomDirectory`, e pelo mesmo motivo: sem serviço de contas, canal nem
 * existe como conceito, e a tela precisa continuar funcionando sem ele.
 */
export function useChannelDirectory(): ChannelDirectory {
  const [directory, setDirectory] = useState<ChannelDirectory>(EMPTY);

  useEffect(() => {
    if (!isAuthConfigured) return undefined;
    const controller = new AbortController();

    void fetchChannelDirectory(undefined, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setDirectory({ channels: page.items });
      })
      .catch(() => {
        // Sem diretório de canais a tela funciona igual.
      });

    return () => controller.abort();
  }, []);

  return directory;
}
