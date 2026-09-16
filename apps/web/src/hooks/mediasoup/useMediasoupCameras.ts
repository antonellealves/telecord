import { useCallback, useMemo, useRef, useState } from 'react';
import type { PeerInfo } from '@telecord/shared';
import { describeCameraError } from '../../lib/errors';
import type { ToastKind } from '../useToasts';
import type { RemoteTrackHandle } from './mediasoupConnection';
import { wrapMediaStreamTrack, type MediasoupTrackHandle } from './mediasoupTrack';
import type { MediasoupEngine } from './useMediasoupEngine';
import { CAMERA_CONSTRAINTS } from '../../lib/videoProfile';
import { withPublishTimeout } from './withPublishTimeout';

export interface MediasoupCameraEntry {
  identity: string;
  displayName: string;
  isLocal: boolean;
  isSpeaking: boolean;
  trackSid: string;
  publication: { track: MediasoupTrackHandle | null };
}

export interface MediasoupCameras {
  entries: MediasoupCameraEntry[];
  isLocalOn: boolean;
  isBusy: boolean;
  disabledReason: string | null;
  start: () => void;
  stop: () => void;
}

function displayNameOf(peers: PeerInfo[], peerId: string): string {
  return peers.find((peer) => peer.peerId === peerId)?.displayName ?? 'alguém';
}

/**
 * Câmeras da sala, no transporte mediasoup — equivalente a `useCameras`.
 *
 * Sem simulcast/publish options finas do LiveKit (`cameraPublishOptions`):
 * o mediasoup-sfu ainda não negocia camadas simulcast do lado do cliente
 * (ver `apps/mediasoup-sfu/src/rooms.ts`), então aqui é publicação única.
 */
export function useMediasoupCameras(
  engine: MediasoupEngine,
  localPeerId: string,
  notify: (kind: ToastKind, message: string) => void,
): MediasoupCameras {
  const [isBusy, setIsBusy] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [localHandle, setLocalHandle] = useState<MediasoupTrackHandle | null>(null);

  const localProducer = engine.localTracks.find((track) => track.trackKind === 'camera') ?? null;
  const isLocalOn = localProducer !== null;

  /*
   * Mesmo cuidado do `useMediasoupScreenShares`: sem cachear por
   * `MediaStreamTrack`, cada heartbeat (o roster muda de referência a cada
   * tick) recriava o wrapper da câmera remota e o <video> em `CameraStrip`
   * reanexava a track a cada poucos segundos.
   */
  const remoteHandleCache = useRef(new Map<MediaStreamTrack, MediasoupTrackHandle>());

  const start = useCallback(() => {
    const connection = engine.connection;
    if (connection === null || isBusy) return;
    setIsBusy(true);
    let capturedStream: MediaStream | null = null;
    void navigator.mediaDevices
      .getUserMedia({ video: CAMERA_CONSTRAINTS })
      .then(async (stream) => {
        capturedStream = stream;
        const track = stream.getVideoTracks()[0];
        if (track === undefined) throw new Error('sem track de vídeo');
        setLocalStream(stream);
        setLocalHandle(wrapMediaStreamTrack(track));
        await withPublishTimeout(connection.publish(track, 'camera'), 'Tempo esgotado ao publicar a câmera.');
      })
      .catch((error: unknown) => {
        // A publicação pode ter ficado presa no meio do handshake — solta a
        // câmera capturada (ver `withPublishTimeout`).
        capturedStream?.getTracks().forEach((track) => track.stop());
        setLocalStream(null);
        setLocalHandle(null);
        notify('error', describeCameraError(error));
      })
      .finally(() => setIsBusy(false));
  }, [engine.connection, isBusy, notify]);

  const stop = useCallback(() => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      if (localProducer !== null) engine.connection?.unpublish(localProducer.producerId);
      for (const track of localStream?.getTracks() ?? []) track.stop();
      setLocalStream(null);
      setLocalHandle(null);
    } finally {
      setIsBusy(false);
    }
  }, [engine.connection, isBusy, localProducer, localStream]);

  const entries = useMemo<MediasoupCameraEntry[]>(() => {
    const remoteCams: RemoteTrackHandle[] = engine.remoteTracks.filter(
      (track) => track.trackKind === 'camera',
    );

    const out: MediasoupCameraEntry[] = [];
    if (isLocalOn && localProducer !== null && localHandle !== null) {
      out.push({
        identity: localPeerId,
        displayName: 'você',
        isLocal: true,
        isSpeaking: false,
        trackSid: localProducer.producerId,
        publication: { track: localHandle },
      });
    }
    const cache = remoteHandleCache.current;
    const liveTracks = new Set<MediaStreamTrack>();
    for (const remote of remoteCams) {
      liveTracks.add(remote.track);
      let handle = cache.get(remote.track);
      if (handle === undefined) {
        handle = wrapMediaStreamTrack(remote.track);
        cache.set(remote.track, handle);
      }
      out.push({
        identity: remote.ownerPeerId,
        displayName: displayNameOf(engine.roster, remote.ownerPeerId),
        isLocal: false,
        isSpeaking: false,
        trackSid: remote.consumerId,
        publication: { track: handle },
      });
    }
    for (const cachedTrack of cache.keys()) {
      if (!liveTracks.has(cachedTrack)) cache.delete(cachedTrack);
    }
    return out.sort((a, b) => (a.trackSid < b.trackSid ? -1 : a.trackSid > b.trackSid ? 1 : 0));
  }, [engine.remoteTracks, engine.roster, isLocalOn, localProducer, localHandle, localPeerId]);

  const supported = typeof navigator.mediaDevices?.getUserMedia === 'function';
  let disabledReason: string | null = null;
  if (isBusy) {
    disabledReason = 'Aguarde…';
  } else if (!supported) {
    disabledReason = 'Este navegador não dá acesso à câmera.';
  }

  return { entries, isLocalOn, isBusy, disabledReason, start, stop };
}
