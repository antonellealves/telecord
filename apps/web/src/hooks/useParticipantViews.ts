import { useCallback, useEffect, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { type Participant, type Room, RoomEvent, Track } from 'livekit-client';
import { AWAY_ATTRIBUTE, AWAY_VALUE, type ParticipantView } from '@telecord/shared';

/**
 * Eventos que mudam a projeção de participantes. Em todos eles o estado é
 * re-derivado inteiro a partir do `Room` — nunca por delta (SPEC §3).
 */
const PARTICIPANT_EVENTS: RoomEvent[] = [
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.ParticipantNameChanged,
  RoomEvent.TrackPublished,
  RoomEvent.TrackUnpublished,
  RoomEvent.TrackSubscribed,
  RoomEvent.TrackUnsubscribed,
  RoomEvent.TrackMuted,
  RoomEvent.TrackUnmuted,
  RoomEvent.LocalTrackPublished,
  RoomEvent.LocalTrackUnpublished,
  RoomEvent.ActiveSpeakersChanged,
  RoomEvent.ParticipantAttributesChanged,
  RoomEvent.ConnectionStateChanged,
  RoomEvent.Reconnected,
];

function isSharingScreen(participant: Participant): boolean {
  for (const publication of participant.trackPublications.values()) {
    if (publication.source === Track.Source.ScreenShare) {
      return true;
    }
  }
  return false;
}

function toView(participant: Participant, isLocal: boolean): ParticipantView {
  return {
    identity: participant.identity,
    displayName: participant.name && participant.name.length > 0 ? participant.name : participant.identity,
    isLocal,
    isSpeaking: participant.isSpeaking,
    isMicrophoneEnabled: participant.isMicrophoneEnabled,
    isSharingScreen: isSharingScreen(participant),
    isAway: participant.attributes[AWAY_ATTRIBUTE] === AWAY_VALUE,
  };
}

function derive(room: Room): ParticipantView[] {
  const local = toView(room.localParticipant, true);
  const remotes = [...room.remoteParticipants.values()]
    .map((participant) => toView(participant, false))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'));
  return [local, ...remotes];
}

/** Lista de participantes derivada do SFU, com quem fala e quem está mutado. */
export function useParticipantViews(): ParticipantView[] {
  const room = useRoomContext();
  const [views, setViews] = useState<ParticipantView[]>(() => derive(room));

  const refresh = useCallback(() => setViews(derive(room)), [room]);

  useEffect(() => {
    refresh();
    for (const event of PARTICIPANT_EVENTS) {
      room.on(event, refresh);
    }
    return () => {
      for (const event of PARTICIPANT_EVENTS) {
        room.off(event, refresh);
      }
    };
  }, [room, refresh]);

  return views;
}
