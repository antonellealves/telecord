import { useEffect, useState } from 'react';
import type { PeerInfo } from '@telecord/shared';
import {
  MediasoupConnection,
  type LocalTrackHandle,
  type MediasoupConnectionState,
  type RemoteTrackHandle,
} from './mediasoupConnection';

export interface MediasoupEngineOptions {
  roomId: string;
  peerId: string;
  displayName: string;
}

/**
 * Sobe uma `MediasoupConnection` por sala e expõe o estado bruto dela como
 * React state — participantes, tracks locais/remotas, estado da conexão.
 *
 * É a ÚNICA instância da conexão por sala: `MediasoupRoomShell` chama este
 * hook uma vez e passa o resultado para baixo, e os hooks especializados
 * (useMediasoupParticipants, useMediasoupChat, etc.) leem/agem sobre ele —
 * nenhum deles abre a própria conexão.
 */
export interface MediasoupEngine {
  connectionState: MediasoupConnectionState;
  roster: PeerInfo[];
  localTracks: LocalTrackHandle[];
  remoteTracks: RemoteTrackHandle[];
  error: string | null;
  connection: MediasoupConnection | null;
  clearError: () => void;
}

export function useMediasoupEngine({ roomId, peerId, displayName }: MediasoupEngineOptions): MediasoupEngine {
  const [connectionState, setConnectionState] = useState<MediasoupConnectionState>('new');
  const [roster, setRoster] = useState<PeerInfo[]>([]);
  const [localTracks, setLocalTracks] = useState<LocalTrackHandle[]>([]);
  const [remoteTracks, setRemoteTracks] = useState<RemoteTrackHandle[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<MediasoupConnection | null>(null);

  useEffect(() => {
    let vivo = true;
    const connectionInstance = new MediasoupConnection(roomId, peerId, displayName, {
      onStateChange: (state) => {
        if (vivo) setConnectionState(state);
      },
      onRosterChange: (peers) => {
        if (vivo) setRoster(peers);
      },
      onRemoteTrack: (handle) => {
        if (!vivo) return;
        setRemoteTracks((current) => [...current, handle]);
      },
      onRemoteTrackEnded: (consumerId) => {
        if (!vivo) return;
        setRemoteTracks((current) => current.filter((entry) => entry.consumerId !== consumerId));
      },
      onLocalTrackChange: (tracks) => {
        if (vivo) setLocalTracks(tracks);
      },
      onError: (message) => {
        if (vivo) setError(message);
      },
      onAttributesReceived: () => undefined,
      onData: () => undefined,
    });
    setConnection(connectionInstance);
    void connectionInstance.connect();

    return () => {
      vivo = false;
      connectionInstance.close();
      setConnection(null);
      setRemoteTracks([]);
      setLocalTracks([]);
    };
  }, [roomId, peerId, displayName]);

  return {
    connectionState,
    roster,
    localTracks,
    remoteTracks,
    error,
    connection,
    clearError: () => setError(null),
  };
}
