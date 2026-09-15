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
  /** O painel admin pediu para mover este par para `roomSlug` — ver `MediasoupConnectionEvents.onForceMoved`. */
  onForceMoved?: (roomSlug: string) => void;
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
  /** `true` quando o painel admin pediu mudo forçado no mic local — ver `onForceMuted`. */
  forceMuted: boolean;
  clearError: () => void;
}

export function useMediasoupEngine({
  roomId,
  peerId,
  displayName,
  onForceMoved,
}: MediasoupEngineOptions): MediasoupEngine {
  const [connectionState, setConnectionState] = useState<MediasoupConnectionState>('new');
  const [roster, setRoster] = useState<PeerInfo[]>([]);
  const [localTracks, setLocalTracks] = useState<LocalTrackHandle[]>([]);
  const [remoteTracks, setRemoteTracks] = useState<RemoteTrackHandle[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<MediasoupConnection | null>(null);
  const [forceMuted, setForceMuted] = useState(false);

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
      onForceMuted: (muted) => {
        if (vivo) setForceMuted(muted);
      },
      onForceMoved: (roomSlug) => {
        if (vivo) onForceMoved?.(roomSlug);
      },
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, peerId, displayName]);

  return {
    connectionState,
    roster,
    localTracks,
    remoteTracks,
    error,
    connection,
    forceMuted,
    clearError: () => setError(null),
  };
}
