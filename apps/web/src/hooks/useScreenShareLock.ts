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

export interface ScreenShareLock {
  /** Publicação vencedora, a única que deve aparecer no palco. */
  active: ScreenShareEntry | null;
  isLocalOwner: boolean;
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
 * Todas as telas publicadas na sala, em ordem total determinística: menor
 * `trackSid` primeiro. O sid é atribuído pelo servidor e é visível para todo
 * mundo, então todos os clientes calculam o mesmo vencedor (SPEC §4.2).
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
      // `.track` sai de undefined. Sem comparar isso, o palco nunca receberia
      // a track e dependeria de outro hook re-renderizar por acaso.
      other.publication.track === entry.publication.track
    );
  });
}

/**
 * Regra de tela única (SPEC §4): checagem client-side + desempate
 * determinístico. Não fecha a corrida — converge depois dela.
 */
export function useScreenShareLock(notify: (kind: ToastKind, message: string) => void): ScreenShareLock {
  const room = useRoomContext();
  const [entries, setEntries] = useState<ScreenShareEntry[]>(() => collectScreenShares(room));
  const [isBusy, setIsBusy] = useState(false);

  const busyRef = useRef(false);
  const resolvingRef = useRef(false);
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

  const active = entries[0] ?? null;
  const localEntry = entries.find((entry) => entry.owner.isLocal) ?? null;
  const isLocalOwner = active !== null && active.owner.isLocal;

  // Desempate: perdi para um sid menor, recolho minha tela.
  useEffect(() => {
    if (entries.length < 2 || active === null || localEntry === null) {
      return;
    }
    if (localEntry.owner.trackSid === active.owner.trackSid || resolvingRef.current) {
      return;
    }

    resolvingRef.current = true;
    const winnerName = active.owner.displayName;
    void room.localParticipant
      .setScreenShareEnabled(false)
      .catch(() => undefined)
      .finally(() => {
        resolvingRef.current = false;
        notifyRef.current(
          'info',
          `${winnerName} entrou primeiro com a tela. Seu compartilhamento foi encerrado.`,
        );
      });
  }, [entries, active, localEntry, room]);

  const start = useCallback(() => {
    if (busyRef.current) {
      return;
    }
    // Lock otimista: desabilita antes do await, para não haver duplo clique.
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
  } else if (!isLocalOwner && active !== null) {
    disabledReason = `${active.owner.displayName} já está compartilhando a tela.`;
  } else if (!isLocalOwner && !isScreenShareSupported()) {
    disabledReason = 'Este navegador não compartilha tela. Use Chrome, Edge ou Firefox no computador.';
  }

  return { active, isLocalOwner, isBusy, disabledReason, start, stop };
}
