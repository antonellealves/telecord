import { useCallback, useState } from 'react';
import { moveParticipant, muteParticipant, removeParticipant } from '../lib/admin';
import { ApiError } from '../lib/apiClient';

export interface RoomModeration {
  /** `identity` de quem tem uma ação em andamento agora, ou null. */
  busy: string | null;
  mute: (identity: string, muted: boolean) => Promise<void>;
  move: (identity: string, destino: string) => Promise<void>;
  remove: (identity: string) => Promise<void>;
}

/**
 * Moderação de dentro da sala, para quem tem a role ADMIN.
 *
 * Reusa as MESMAS rotas `/admin/live/:slug/:identity/*` que o painel externo
 * já usa (`apps/web/src/components/AdminLive.tsx`) — o servidor decide quem
 * pode chamar (`@Roles('ADMIN')` na classe do `AdminController`), então não
 * existe caminho novo de autorização aqui, só uma segunda superfície para a
 * mesma ação: fazer sentido agir sem sair da chamada para abrir o painel.
 *
 * `onError` recebe a mensagem pronta para toast — o chamador decide como
 * mostrar (aqui, `push('error', ...)` do RoomShell).
 */
export function useRoomModeration(roomId: string, onError: (message: string) => void): RoomModeration {
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(
    async (identity: string, action: () => Promise<void>) => {
      setBusy(identity);
      try {
        await action();
      } catch (error) {
        onError(error instanceof ApiError ? error.message : 'A ação de moderação não funcionou.');
      } finally {
        setBusy(null);
      }
    },
    [onError],
  );

  const mute = useCallback(
    (identity: string, muted: boolean) =>
      run(identity, () => muteParticipant(roomId, identity, muted, 'LIVEKIT')),
    [roomId, run],
  );

  const move = useCallback(
    (identity: string, destino: string) =>
      run(identity, () => moveParticipant(roomId, identity, destino, 'LIVEKIT')),
    [roomId, run],
  );

  const remove = useCallback(
    (identity: string) => run(identity, () => removeParticipant(roomId, identity, 'LIVEKIT')),
    [roomId, run],
  );

  return { busy, mute, move, remove };
}
