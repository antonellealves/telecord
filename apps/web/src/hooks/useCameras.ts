import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { type Participant, type Room, RoomEvent, Track, type TrackPublication } from 'livekit-client';
import { describeCameraError } from '../lib/errors';
import { cameraCaptureOptions, cameraPublishOptions } from '../lib/media';
import type { ToastKind } from './useToasts';

export interface CameraEntry {
  identity: string;
  displayName: string;
  isLocal: boolean;
  isSpeaking: boolean;
  trackSid: string;
  publication: TrackPublication;
}

export interface Cameras {
  entries: CameraEntry[];
  isLocalOn: boolean;
  isBusy: boolean;
  disabledReason: string | null;
  start: () => void;
  stop: () => void;
}

const CAMERA_EVENTS: RoomEvent[] = [
  RoomEvent.TrackPublished,
  RoomEvent.TrackUnpublished,
  RoomEvent.TrackSubscribed,
  RoomEvent.TrackUnsubscribed,
  RoomEvent.TrackMuted,
  RoomEvent.TrackUnmuted,
  RoomEvent.LocalTrackPublished,
  RoomEvent.LocalTrackUnpublished,
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.ActiveSpeakersChanged,
  RoomEvent.ConnectionStateChanged,
  RoomEvent.Reconnected,
];

function label(participant: Participant): string {
  return participant.name && participant.name.length > 0 ? participant.name : participant.identity;
}

/** Ordem estável por trackSid: o mosaico não pode reembaralhar sozinho. */
function collectCameras(room: Room): CameraEntry[] {
  const participants: { participant: Participant; isLocal: boolean }[] = [
    { participant: room.localParticipant, isLocal: true },
    ...[...room.remoteParticipants.values()].map((participant) => ({
      participant,
      isLocal: false,
    })),
  ];

  const entries: CameraEntry[] = [];
  for (const { participant, isLocal } of participants) {
    for (const publication of participant.trackPublications.values()) {
      // Publicação silenciada continua existindo no roster; mostrar um quadro
      // preto para ela seria pior do que não mostrar quadro nenhum.
      if (publication.source !== Track.Source.Camera || publication.isMuted) {
        continue;
      }
      entries.push({
        identity: participant.identity,
        displayName: label(participant),
        isLocal,
        isSpeaking: participant.isSpeaking,
        trackSid: publication.trackSid,
        publication,
      });
    }
  }

  return entries.sort((a, b) => {
    if (a.trackSid < b.trackSid) return -1;
    if (a.trackSid > b.trackSid) return 1;
    return 0;
  });
}

function sameEntries(a: CameraEntry[], b: CameraEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      other.trackSid === entry.trackSid &&
      other.publication === entry.publication &&
      other.isSpeaking === entry.isSpeaking &&
      // O objeto da publicação não muda quando a track é assinada: só o campo
      // `.track` sai de undefined.
      other.publication.track === entry.publication.track
    );
  });
}

/**
 * Câmeras da sala.
 *
 * Câmera e tela são fontes independentes no LiveKit, então publicar as duas ao
 * mesmo tempo não exige nada de especial — quem publica tela continua podendo
 * aparecer. O que exige atenção é a banda: cada câmera ligada soma egress para
 * todos os assistentes (SPEC §6.9).
 */
export function useCameras(notify: (kind: ToastKind, message: string) => void): Cameras {
  const room = useRoomContext();
  const [entries, setEntries] = useState<CameraEntry[]>(() => collectCameras(room));
  const [isBusy, setIsBusy] = useState(false);

  const busyRef = useRef(false);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  useEffect(() => {
    const refresh = (): void => {
      setEntries((current) => {
        const next = collectCameras(room);
        return sameEntries(current, next) ? current : next;
      });
    };

    refresh();
    for (const event of CAMERA_EVENTS) {
      room.on(event, refresh);
    }
    return () => {
      for (const event of CAMERA_EVENTS) {
        room.off(event, refresh);
      }
    };
  }, [room]);

  const isLocalOn = entries.some((entry) => entry.isLocal);

  const toggle = useCallback(
    (enabled: boolean) => {
      if (busyRef.current) {
        return;
      }
      busyRef.current = true;
      setIsBusy(true);
      void room.localParticipant
        .setCameraEnabled(enabled, cameraCaptureOptions, cameraPublishOptions)
        .catch((error: unknown) => {
          notifyRef.current('error', describeCameraError(error));
        })
        .finally(() => {
          busyRef.current = false;
          setIsBusy(false);
        });
    },
    [room],
  );

  const supported = typeof navigator.mediaDevices?.getUserMedia === 'function';

  let disabledReason: string | null = null;
  if (isBusy) {
    disabledReason = 'Aguarde…';
  } else if (!supported) {
    disabledReason = 'Este navegador não dá acesso à câmera.';
  }

  return {
    entries,
    isLocalOn,
    isBusy,
    disabledReason,
    start: () => toggle(true),
    stop: () => toggle(false),
  };
}
