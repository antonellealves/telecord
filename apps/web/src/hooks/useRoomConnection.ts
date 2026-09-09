import { useEffect, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { ConnectionState, RoomEvent } from 'livekit-client';

export type RoomConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

function toStatus(state: ConnectionState): RoomConnectionStatus {
  switch (state) {
    case ConnectionState.Connected:
      return 'connected';
    case ConnectionState.Connecting:
      return 'connecting';
    case ConnectionState.Reconnecting:
    case ConnectionState.SignalReconnecting:
      return 'reconnecting';
    case ConnectionState.Disconnected:
      return 'disconnected';
    default:
      return 'connecting';
  }
}

/** Traduz o estado do Room no enum que a UI mostra (SPEC §3, §5). */
export function useRoomConnectionStatus(): RoomConnectionStatus {
  const room = useRoomContext();
  const [status, setStatus] = useState<RoomConnectionStatus>(() => toStatus(room.state));

  useEffect(() => {
    const handle = (state: ConnectionState): void => setStatus(toStatus(state));
    setStatus(toStatus(room.state));
    room.on(RoomEvent.ConnectionStateChanged, handle);
    return () => {
      room.off(RoomEvent.ConnectionStateChanged, handle);
    };
  }, [room]);

  return status;
}

/** Áudio bloqueado pela política de autoplay do navegador (SPEC §5). */
export function useAudioPlaybackBlocked(): { blocked: boolean; unblock: () => void } {
  const room = useRoomContext();
  const [blocked, setBlocked] = useState(() => !room.canPlaybackAudio);

  useEffect(() => {
    const handle = (): void => setBlocked(!room.canPlaybackAudio);
    handle();
    room.on(RoomEvent.AudioPlaybackStatusChanged, handle);
    return () => {
      room.off(RoomEvent.AudioPlaybackStatusChanged, handle);
    };
  }, [room]);

  return {
    blocked,
    unblock: () => {
      void room.startAudio();
    },
  };
}
