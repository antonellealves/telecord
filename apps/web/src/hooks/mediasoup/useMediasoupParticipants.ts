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
      isSpeaking: false,
      isMicrophoneEnabled: localMicOn,
      isSharingScreen: localSharing,
      isAway: false,
    };

    const remotes: ParticipantView[] = engine.roster
      .filter((peer) => peer.peerId !== localPeerId)
      .map((peer) => {
        const tracks = peer.mediasoup?.tracks ?? [];
        return {
          identity: peer.peerId,
          displayName: peer.displayName,
          isLocal: false,
          // Detecção de quem fala não existe ainda no protocolo do mediasoup
          // (o LiveKit calcula no servidor, via nível de áudio) — fica falso
          // até essa métrica existir; não afeta mic/tela, só o destaque visual.
          isSpeaking: false,
          isMicrophoneEnabled: tracks.some((track) => track.trackKind === 'mic'),
          isSharingScreen: tracks.some((track) => track.trackKind === 'screen-video'),
          isAway: false,
        };
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'));

    return [local, ...remotes];
  }, [engine.roster, engine.localTracks, localPeerId, localDisplayName]);
}
