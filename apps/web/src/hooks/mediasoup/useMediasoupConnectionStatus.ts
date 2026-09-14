import type { RoomConnectionStatus } from '../useRoomConnection';
import type { MediasoupConnectionState } from './mediasoupConnection';
import type { MediasoupEngine } from './useMediasoupEngine';

function toStatus(state: MediasoupConnectionState): RoomConnectionStatus {
  switch (state) {
    case 'connected':
      return 'connected';
    case 'connecting':
    case 'new':
      return 'connecting';
    case 'disconnected':
      return 'disconnected';
    case 'failed':
    default:
      return 'disconnected';
  }
}

/** Equivalente a `useRoomConnectionStatus`, lendo do engine mediasoup em vez do `Room` do LiveKit. */
export function useMediasoupConnectionStatus(engine: MediasoupEngine): RoomConnectionStatus {
  return toStatus(engine.connectionState);
}
