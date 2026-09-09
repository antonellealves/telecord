import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { type Participant, type Room, RoomEvent, Track, type TrackPublication } from 'livekit-client';
import type { ScreenShareOwner } from '@telecord/shared';
import { describeScreenShareError, isScreenShareSupported } from '../lib/errors';
import { screenShareCaptureOptions } from '../lib/media';
import type { ToastKind } from './useToasts';

export interface ScreenShareEntry {
  owner: ScreenShareOwner;
  publication: TrackPublication;
}

export interface ScreenShares {
  entries: ScreenShareEntry[];
  isLocalSharing: boolean;
  isBusy: boolean;
  /** `null` = botão habilitado; string = motivo do bloqueio (vira tooltip). */
  disabledReason: string | null;
  start: () => void;
  stop: () => void;
}

const SHARE_EVENTS: RoomEvent[] = [
  RoomEvent.TrackPublished,
  RoomEvent.TrackUnpublished,
  RoomEvent.TrackSubscribed,
  RoomEvent.TrackUnsubscribed,
  RoomEvent.LocalTrackPublished,
  RoomEvent.LocalTrackUnpublished,
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.ConnectionStateChanged,
  RoomEvent.Reconnected,
];

function participantLabel(participant: Participant): string {
  return participant.name && participant.name.length > 0 ? participant.name : participant.identity;
}

/**
 * Todas as telas publicadas na sala, em ordem estável por `trackSid`.
 *
 * A ordenação existe para o palco não reembaralhar sozinho: o sid é atribuído
 * pelo servidor e é o mesmo para todo mundo, então todos veem os quadros na
 * mesma ordem, e um participante entrando não muda a posição dos demais.
 */
function collectScreenShares(room: Room): ScreenShareEntry[] {
  const participants: { participant: Participant; isLocal: boolean }[] = [
    { participant: room.localParticipant, isLocal: true },
    ...[...room.remoteParticipants.values()].map((participant) => ({
      participant,
      isLocal: false,
    })),
  ];

  const entries: ScreenShareEntry[] = [];
  for (const { participant, isLocal } of participants) {
    for (const publication of participant.trackPublications.values()) {
      if (publication.source !== Track.Source.ScreenShare) {
        continue;
      }
      entries.push({
        owner: {
          identity: participant.identity,
          displayName: participantLabel(participant),
          isLocal,
          trackSid: publication.trackSid,
        },
        publication,
      });
    }
  }

  return entries.sort((a, b) => {
    if (a.owner.trackSid < b.owner.trackSid) return -1;
    if (a.owner.trackSid > b.owner.trackSid) return 1;
    return 0;
  });
}

function sameEntries(a: ScreenShareEntry[], b: ScreenShareEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      other.owner.trackSid === entry.owner.trackSid &&
      other.publication === entry.publication &&
      // O objeto da publicação não muda quando a track é assinada: só o campo
      // `.track` sai de undefined. Sem comparar isso, o quadro nunca receberia
      // a track e dependeria de outro hook re-renderizar por acaso.
      other.publication.track === entry.publication.track
    );
  });
}

/**
 * Compartilhamento de tela, sem limite de quantas ao mesmo tempo.
 *
 * A versão anterior impunha uma tela por vez com desempate por menor sid.
 * Isso caiu: várias pessoas podem publicar, e o palco vira grade. O custo é
 * de banda — cada tela extra multiplica o egress do SFU (SPEC §6.5).
 */
export function useScreenShares(notify: (kind: ToastKind, message: string) => void): ScreenShares {
  const room = useRoomContext();
  const [entries, setEntries] = useState<ScreenShareEntry[]>(() => collectScreenShares(room));
  const [isBusy, setIsBusy] = useState(false);

  const busyRef = useRef(false);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  useEffect(() => {
    const refresh = (): void => {
      setEntries((current) => {
        const next = collectScreenShares(room);
        return sameEntries(current, next) ? current : next;
      });
    };

    refresh();
    for (const event of SHARE_EVENTS) {
      room.on(event, refresh);
    }
    return () => {
      for (const event of SHARE_EVENTS) {
        room.off(event, refresh);
      }
    };
  }, [room]);

  const isLocalSharing = entries.some((entry) => entry.owner.isLocal);

  const start = useCallback(() => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setIsBusy(true);
    void room.localParticipant
      .setScreenShareEnabled(true, screenShareCaptureOptions)
      .catch((error: unknown) => {
        const message = describeScreenShareError(error);
        if (message !== null) {
          notifyRef.current('error', message);
        }
      })
      .finally(() => {
        busyRef.current = false;
        setIsBusy(false);
      });
  }, [room]);

  const stop = useCallback(() => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setIsBusy(true);
    void room.localParticipant
      .setScreenShareEnabled(false)
      .catch(() => {
        notifyRef.current('error', 'Não foi possível encerrar o compartilhamento.');
      })
      .finally(() => {
        busyRef.current = false;
        setIsBusy(false);
      });
  }, [room]);

  let disabledReason: string | null = null;
  if (isBusy) {
    disabledReason = 'Aguarde…';
  } else if (!isLocalSharing && !isScreenShareSupported()) {
    disabledReason = 'Este navegador não compartilha tela. Use Chrome, Edge ou Firefox no computador.';
  }

  return { entries, isLocalSharing, isBusy, disabledReason, start, stop };
}
