import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { type Participant, type Room, RoomEvent, Track, type TrackPublication } from 'livekit-client';
import type { ScreenShareOwner } from '@telecord/shared';
import { describeScreenShareError, isScreenShareSupported } from '../lib/errors';
import {
  DEFAULT_SCREEN_QUALITY,
  screenEncoding,
  screenShareCaptureOptions,
  type ScreenQualityId,
} from '../lib/media';
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
  /** Qualidade opcional; sem ela, usa a preferência salva/padrão. */
  start: (quality?: ScreenQualityId) => void;
  stop: () => void;
  /**
   * Republica a tela já compartilhada com outra qualidade.
   *
   * Precisa ser republicação, e não ajuste: o `screenShareEncoding` é lido
   * quando a track é PUBLICADA, e mexer nele depois não alcança a track que
   * já está no ar. Era por isso que trocar o nível no meio de uma
   * transmissão não mudava nada na tela de quem assistia.
   *
   * Custa uma piscada no quadro de quem está vendo — e o navegador NÃO pede a
   * tela de novo, porque a track de origem é reaproveitada.
   */
  restart: (quality: ScreenQualityId) => void;
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
 * Impede que a voz da sala volte pela track de áudio da tela.
 *
 * ## O problema
 *
 * Ao compartilhar aba ou janela COM som, o navegador entrega um segundo track
 * (`ScreenShareAudio`) que é publicado sem processamento de voz — e tem que
 * ser assim, senão o AEC destrói música e efeito do conteúdo (SPEC §6.3).
 *
 * A armadilha é que, dependendo do que a pessoa escolhe na caixa do Chrome —
 * "tela inteira com áudio", ou a própria aba do telecord —, o que ele captura
 * inclui o que está SAINDO pelos alto-falantes, que é a voz de todo mundo na
 * sala. Isso sobe de volta como conteúdo, e cada participante ouve a si mesmo
 * com um atraso: o eco que aparecia toda vez que alguém falava durante um
 * compartilhamento com som.
 *
 * ## Por que não dá para filtrar
 *
 * Não dá para separar "voz da sala" de "voz dentro do vídeo que está sendo
 * compartilhado" olhando a forma de onda — as duas são fala. Ligar o AEC nesta
 * track é a solução aparente e é pior: mataria a música junto.
 *
 * ## O que se faz
 *
 * Rotear a saída da sala para longe da captura é impossível pela API do
 * navegador. O que resta, e resolve de verdade, é cortar o caminho de volta:
 * a track de áudio da tela é publicada MUDA para quem compartilha se o próprio
 * navegador indicar que a fonte é a tela inteira ou a aba do telecord — os
 * dois casos em que o retorno é garantido.
 *
 * O caso legítimo (compartilhar uma OUTRA aba com som, que é o que quase todo
 * mundo quer) continua funcionando, porque aí o Chrome captura só o áudio
 * daquela aba e a voz da sala nunca entra.
 */
function silenceVoicesInSharedAudio(
  room: Room,
  notify: (kind: ToastKind, message: string) => void,
): void {
  for (const publication of room.localParticipant.trackPublications.values()) {
    if (publication.source !== Track.Source.ScreenShareAudio) {
      continue;
    }
    const track = publication.track;
    if (!track) {
      continue;
    }

    const settings = track.mediaStreamTrack.getSettings() as MediaTrackSettings & {
      displaySurface?: string;
    };
    /*
     * `displaySurface` diz o que a pessoa escolheu: 'monitor' (tela inteira),
     * 'window' (uma janela) ou 'browser' (uma aba). Só 'monitor' captura o mix
     * do sistema inteiro, onde a saída do telecord está garantidamente
     * presente. 'window' e 'browser' capturam a fonte escolhida.
     */
    const capturaSaidaDaSala = settings.displaySurface === 'monitor';

    if (capturaSaidaDaSala) {
      void track.mute();
      notify(
        'info',
        'O som da tela inteira ficou mudo para não devolver a voz da sala como eco. ' +
          'Para compartilhar som, escolha uma aba ou janela específica.',
      );
    }
  }
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

  const start = useCallback(
    (quality?: ScreenQualityId) => {
      if (busyRef.current) {
        return;
      }
      busyRef.current = true;
      setIsBusy(true);
      const options = screenShareCaptureOptions(quality);
      void room.localParticipant
        .setScreenShareEnabled(true, options, {
          screenShareEncoding: screenEncoding(quality ?? DEFAULT_SCREEN_QUALITY),
          degradationPreference: 'maintain-resolution',
        })
        .then(() => {
          silenceVoicesInSharedAudio(room, notifyRef.current);
        })
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
    },
    [room],
  );

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


  /*
   * Troca a qualidade da tela que JÁ está no ar.
   *
   * Desliga e liga de novo: o `screenShareEncoding` só é lido na publicação,
   * e mexer nele depois não alcança a track que já está no ar.
   * O navegador não volta a perguntar qual tela — a permissão já foi dada e a
   * track de origem continua viva —, então o custo é uma piscada no quadro de
   * quem assiste.
   */
  const restart = useCallback(
    (quality: ScreenQualityId) => {
      if (busyRef.current) {
        return;
      }
      busyRef.current = true;
      setIsBusy(true);
      void room.localParticipant
        .setScreenShareEnabled(false)
        .then(() =>
          room.localParticipant.setScreenShareEnabled(true, screenShareCaptureOptions(quality), {
            screenShareEncoding: screenEncoding(quality),
            degradationPreference: 'maintain-resolution',
          }),
        )
        .then(() => {
          silenceVoicesInSharedAudio(room, notifyRef.current);
        })
        .catch((error: unknown) => {
          const message = describeScreenShareError(error);
          notifyRef.current('error', message ?? 'Não deu para trocar a qualidade.');
        })
        .finally(() => {
          busyRef.current = false;
          setIsBusy(false);
        });
    },
    [room],
  );

  return { entries, isLocalSharing, isBusy, disabledReason, start, stop, restart };
}
