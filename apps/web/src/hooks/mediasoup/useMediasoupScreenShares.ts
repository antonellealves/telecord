import { useCallback, useMemo, useRef, useState } from 'react';
import type { PeerInfo, ScreenShareOwner } from '@telecord/shared';
import { describeScreenShareError, isScreenShareSupported } from '../../lib/errors';
import { DEFAULT_SCREEN_QUALITY, type ScreenQualityId } from '../../lib/media';
import { screenCaptureConstraints } from '../../lib/videoProfile';
import type { ToastKind } from '../useToasts';
import type { RemoteTrackHandle } from './mediasoupConnection';
import { wrapMediaStreamTrack, type MediasoupTrackHandle } from './mediasoupTrack';
import type { MediasoupEngine } from './useMediasoupEngine';
import { withPublishTimeout } from './withPublishTimeout';

export interface MediasoupScreenPublication {
  track: MediasoupTrackHandle | null;
  /**
   * Só nas telas dos OUTROS, e só com o canal de mídia: pede ao SFU que pare
   * (ou volte) a mandar esta tela para este navegador. É a presença deste
   * método que faz o `ScreenStage` mostrar o botão de "parar de assistir" —
   * mesmo nome e mesmo sentido do `setSubscribed` do livekit-client, para o
   * componente não precisar saber qual transporte está por trás.
   */
  setSubscribed?: (subscribed: boolean) => void;
}

export interface MediasoupScreenShareEntry {
  owner: ScreenShareOwner;
  publication: MediasoupScreenPublication;
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
 * republica com um encoding diferente (`screenShareEncoding`). Aqui a troca
 * em pleno compartilhamento ainda não existe — o nível escolhido vale para a
 * próxima vez que a pessoa compartilhar.
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

  /*
   * `entries` é recalculado a cada heartbeat (o roster muda de referência a
   * cada tick de `TICK_MS`, mesmo sem nenhuma track entrando ou saindo).
   * Sem este cache, cada recálculo criava um `wrapMediaStreamTrack` NOVO
   * para a mesma `MediaStreamTrack` remota — e como `ScreenTile` reanexa o
   * vídeo (`track.attach`/`detach`) toda vez que a referência de `track`
   * muda, a tela do outro participante ficava sendo desconectada e
   * reconectada do elemento <video> a cada 2.5s, aparecendo preta/travada.
   * A local não sofria porque já vinha de `useState` (referência estável).
   *
   * O que fica em cache é a PUBLICAÇÃO inteira, não só a track: o
   * `ScreenStage` repõe a assinatura (`setSubscribed(true)`) toda vez que a
   * referência da publicação muda, então um objeto novo a cada render
   * desfaria o "parar de assistir" no instante seguinte ao clique.
   */
  const remotePublicationCache = useRef(new Map<MediaStreamTrack, MediasoupScreenPublication>());

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

      const chosenQuality = quality ?? DEFAULT_SCREEN_QUALITY;
      let capturedStream: MediaStream | null = null;
      void navigator.mediaDevices
        .getDisplayMedia(screenCaptureConstraints(chosenQuality))
        .then(async (stream) => {
          capturedStream = stream;
          const videoTrack = stream.getVideoTracks()[0];
          if (videoTrack === undefined) throw new Error('sem track de vídeo');
          videoTrack.addEventListener('ended', () => stop());
          setLocalStream(stream);
          setLocalVideoHandle(wrapMediaStreamTrack(videoTrack));

          await withPublishTimeout(
            connection.publish(videoTrack, 'screen-video', chosenQuality),
            'Tempo esgotado ao publicar o vídeo da tela.',
          );
          const audioTrack = stream.getAudioTracks()[0];
          if (audioTrack !== undefined) {
            await withPublishTimeout(
              connection.publish(audioTrack, 'screen-audio'),
              'Tempo esgotado ao publicar o áudio da tela.',
            );
          }
        })
        .catch((error: unknown) => {
          // A publicação pode ter ficado presa no meio do handshake — solta a
          // tela capturada para não deixar o navegador "compartilhando" algo
          // que nunca chegou a ser publicado (ver `withPublishTimeout`).
          capturedStream?.getTracks().forEach((track) => track.stop());
          setLocalStream(null);
          setLocalVideoHandle(null);
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
    const cache = remotePublicationCache.current;
    const connection = engine.connection;
    const liveTracks = new Set<MediaStreamTrack>();
    for (const remote of remoteShares) {
      liveTracks.add(remote.track);
      let publication = cache.get(remote.track);
      if (publication === undefined) {
        publication = { track: wrapMediaStreamTrack(remote.track) };
        if (connection !== null && connection.canPauseRemoteTracks) {
          const { consumerId } = remote;
          publication.setSubscribed = (subscribed) => {
            void connection.setRemoteTrackPaused(consumerId, !subscribed).catch(() => undefined);
          };
        }
        cache.set(remote.track, publication);
      }
      out.push({
        owner: {
          identity: remote.ownerPeerId,
          displayName: displayNameOf(engine.roster, remote.ownerPeerId),
          isLocal: false,
          trackSid: remote.consumerId,
        },
        publication,
      });
    }
    for (const cachedTrack of cache.keys()) {
      if (!liveTracks.has(cachedTrack)) cache.delete(cachedTrack);
    }
    return out.sort((a, b) => (a.owner.trackSid < b.owner.trackSid ? -1 : a.owner.trackSid > b.owner.trackSid ? 1 : 0));
  }, [
    engine.remoteTracks,
    engine.roster,
    engine.connection,
    isLocalSharing,
    localVideoProducer,
    localVideoHandle,
    localPeerId,
  ]);

  let disabledReason: string | null = null;
  if (isBusy) {
    disabledReason = 'Aguarde…';
  } else if (!isLocalSharing && !isScreenShareSupported()) {
    disabledReason = 'Este navegador não compartilha tela. Use Chrome, Edge ou Firefox no computador.';
  }

  return { entries, isLocalSharing, isBusy, disabledReason, start, stop };
}
