import { useCallback, useMemo, useState } from 'react';
import type { PeerInfo, ScreenShareOwner } from '@telecord/shared';
import { describeScreenShareError, isScreenShareSupported } from '../../lib/errors';
import { DEFAULT_SCREEN_QUALITY, screenShareCaptureOptions, type ScreenQualityId } from '../../lib/media';
import type { ToastKind } from '../useToasts';
import type { RemoteTrackHandle } from './mediasoupConnection';
import { wrapMediaStreamTrack, type MediasoupTrackHandle } from './mediasoupTrack';
import type { MediasoupEngine } from './useMediasoupEngine';

export interface MediasoupScreenShareEntry {
  owner: ScreenShareOwner;
  publication: { track: MediasoupTrackHandle | null };
}

export interface MediasoupScreenShares {
  entries: MediasoupScreenShareEntry[];
  isLocalSharing: boolean;
  isBusy: boolean;
  disabledReason: string | null;
  start: (quality?: ScreenQualityId) => void;
  stop: () => void;
}

function displayNameOf(peers: PeerInfo[], peerId: string): string {
  return peers.find((peer) => peer.peerId === peerId)?.displayName ?? 'alguém';
}

/**
 * Compartilhamento de tela no transporte mediasoup — equivalente a
 * `useScreenShares`.
 *
 * Sem `restart()`: no LiveKit, trocar a qualidade de uma tela JÁ no ar
 * republica com um encoding diferente (`screenShareEncoding`). O mediasoup
 * ainda publica com um único perfil de bitrate fixo do lado do servidor (ver
 * `apps/mediasoup-sfu/src/rooms.ts`, `initialAvailableOutgoingBitrate`) — a
 * troca de qualidade em pleno compartilhamento fica para quando o SFU
 * expuser controle de bitrate por producer.
 */
export function useMediasoupScreenShares(
  engine: MediasoupEngine,
  localPeerId: string,
  notify: (kind: ToastKind, message: string) => void,
): MediasoupScreenShares {
  const [isBusy, setIsBusy] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [localVideoHandle, setLocalVideoHandle] = useState<MediasoupTrackHandle | null>(null);

  const localVideoProducer = engine.localTracks.find((track) => track.trackKind === 'screen-video') ?? null;
  const isLocalSharing = localVideoProducer !== null;

  const stop = useCallback(() => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      for (const track of engine.localTracks) {
        if (track.trackKind === 'screen-video' || track.trackKind === 'screen-audio') {
          engine.connection?.unpublish(track.producerId);
        }
      }
      for (const track of localStream?.getTracks() ?? []) track.stop();
      setLocalStream(null);
      setLocalVideoHandle(null);
    } finally {
      setIsBusy(false);
    }
  }, [engine, isBusy, localStream]);

  const start = useCallback(
    (quality?: ScreenQualityId) => {
      const connection = engine.connection;
      if (connection === null || isBusy) return;
      setIsBusy(true);

      void navigator.mediaDevices
        .getDisplayMedia(screenShareCaptureOptions(quality ?? DEFAULT_SCREEN_QUALITY))
        .then(async (stream) => {
          const videoTrack = stream.getVideoTracks()[0];
          if (videoTrack === undefined) throw new Error('sem track de vídeo');
          videoTrack.addEventListener('ended', () => stop());
          setLocalStream(stream);
          setLocalVideoHandle(wrapMediaStreamTrack(videoTrack));

          await connection.publish(videoTrack, 'screen-video');
          const audioTrack = stream.getAudioTracks()[0];
          if (audioTrack !== undefined) {
            await connection.publish(audioTrack, 'screen-audio');
          }
        })
        .catch((error: unknown) => {
          const message = describeScreenShareError(error);
          if (message !== null) notify('error', message);
        })
        .finally(() => setIsBusy(false));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine.connection, isBusy, notify, stop],
  );

  const entries = useMemo<MediasoupScreenShareEntry[]>(() => {
    const remoteShares: RemoteTrackHandle[] = engine.remoteTracks.filter(
      (track) => track.trackKind === 'screen-video',
    );

    const out: MediasoupScreenShareEntry[] = [];
    if (isLocalSharing && localVideoProducer !== null && localVideoHandle !== null) {
      out.push({
        owner: {
          identity: localPeerId,
          displayName: 'você',
          isLocal: true,
          trackSid: localVideoProducer.producerId,
        },
        publication: { track: localVideoHandle },
      });
    }
    for (const remote of remoteShares) {
      out.push({
        owner: {
          identity: remote.ownerPeerId,
          displayName: displayNameOf(engine.roster, remote.ownerPeerId),
          isLocal: false,
          trackSid: remote.consumerId,
        },
        publication: { track: wrapMediaStreamTrack(remote.track) },
      });
    }
    return out.sort((a, b) => (a.owner.trackSid < b.owner.trackSid ? -1 : a.owner.trackSid > b.owner.trackSid ? 1 : 0));
  }, [engine.remoteTracks, engine.roster, isLocalSharing, localVideoProducer, localVideoHandle, localPeerId]);

  let disabledReason: string | null = null;
  if (isBusy) {
    disabledReason = 'Aguarde…';
  } else if (!isLocalSharing && !isScreenShareSupported()) {
    disabledReason = 'Este navegador não compartilha tela. Use Chrome, Edge ou Firefox no computador.';
  }

  return { entries, isLocalSharing, isBusy, disabledReason, start, stop };
}
