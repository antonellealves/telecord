import { useMemo } from 'react';
import type { ParticipantView } from '@telecord/shared';
import type { MediasoupEngine } from './useMediasoupEngine';

/**
 * Lista de participantes derivada do engine mediasoup — equivalente a
 * `useParticipantViews`, mas sem depender do `Room` do livekit-client (ver
 * `mediasoupConnection.ts` para o porquê dos dois caminhos serem separados).
 *
 * `isMicrophoneEnabled`/`isSharingScreen` de um participante REMOTO são
 * inferidos das tracks que o roster anuncia; do participante LOCAL, das
 * tracks publicadas pelo próprio engine — as duas fontes têm o mesmo formato
 * (`MediasoupTrackKind`), então a derivação é a mesma função nos dois casos.
 *
 * `isSpeaking` vem do SFU, que mede o nível do áudio que encaminha — como o
 * LiveKit faz. O próprio participante entra na medição, então a pessoa também
 * se vê falando.
 */
export function useMediasoupParticipants(
  engine: MediasoupEngine,
  localPeerId: string,
  localDisplayName: string,
): ParticipantView[] {
  return useMemo<ParticipantView[]>(() => {
    const localMicOn = engine.localTracks.some((track) => track.trackKind === 'mic');
    const localSharing = engine.localTracks.some((track) => track.trackKind === 'screen-video');

    const local: ParticipantView = {
      identity: localPeerId,
      displayName: localDisplayName,
      isLocal: true,
      // Só com o microfone no ar: o destaque sustenta alguns instantes depois
      // da última sílaba, e não deve sobrar aceso em quem acabou de se mutar.
      isSpeaking: localMicOn && engine.speakingPeerIds.has(localPeerId),
      isMicrophoneEnabled: localMicOn,
      isSharingScreen: localSharing,
      isAway: false,
    };

    const remotes: ParticipantView[] = engine.roster
      .filter((peer) => peer.peerId !== localPeerId)
      .map((peer) => {
        const tracks = peer.mediasoup?.tracks ?? [];
        const micOn = tracks.some((track) => track.trackKind === 'mic');
        return {
          identity: peer.peerId,
          displayName: peer.displayName,
          isLocal: false,
          isSpeaking: micOn && engine.speakingPeerIds.has(peer.peerId),
          isMicrophoneEnabled: micOn,
          isSharingScreen: tracks.some((track) => track.trackKind === 'screen-video'),
          isAway: false,
        };
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'));

    return [local, ...remotes];
  }, [engine.roster, engine.localTracks, engine.speakingPeerIds, localPeerId, localDisplayName]);
}
