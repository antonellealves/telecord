import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerPresenceEvents,
  LiveParticipant,
  LiveRoom,
  PresenceRosterUpdate,
  ServerToClientPresenceEvents,
} from '@telecord/shared';
import {
  deleteLiveRoom,
  fetchLiveParticipants,
  fetchLiveRooms,
  moveParticipant,
  muteParticipant,
  removeParticipant,
} from '../lib/admin';
import { ApiError } from '../lib/apiClient';
import { MEDIASOUP_PUBLIC_URL } from '../lib/config';
import { fetchAdminPresenceToken } from '../lib/mediasoup';
import { formatWhen } from './AdminLogs';
import styles from './Admin.module.css';

/** Recarrega sozinho: quem entra e sai muda a cada segundo. */
const REFRESH_MS = 5000;

/**
 * Estado do mic, nas duas fontes possíveis.
 *
 * LiveKit sabe de verdade, por track (`tracks[].muted`, aplicado pelo
 * servidor). mediasoup não tem essa fonte — `tracks` chega sempre vazio (ver
 * `MediasoupModerationService.liveParticipants`) —, então o que o painel
 * mostra ali é o COMANDO pendente (`pendingCommand.forceMuted`), que só vira
 * realidade quando o cliente da pessoa obedecer no próximo heartbeat.
 */
/**
 * Reconstrói um `LiveParticipant` a partir de uma entrada pura de
 * `roster:update` (peerId/displayName/joinedAt), preservando `isAnonymous`/
 * `pendingCommand` de quem já estava na lista carregada por HTTP — o socket
 * não carrega essas duas coisas (continuam só em `PeerPresence`/Prisma, ver
 * `MediasoupModerationService.liveParticipants`).
 */
function rosterEntryToParticipant(
  peer: PresenceRosterUpdate['peers'][number],
  current: LiveParticipant[],
): LiveParticipant {
  const existing = current.find((p) => p.identity === peer.peerId);
  return {
    identity: peer.peerId,
    displayName: peer.displayName,
    joinedAt: peer.joinedAt,
    isAnonymous: existing?.isAnonymous ?? true,
    tracks: [],
    pendingCommand: existing?.pendingCommand ?? null,
  };
}

function isMicMuted(participant: LiveParticipant): boolean | null {
  if (participant.pendingCommand !== undefined) {
    return participant.pendingCommand?.forceMuted ?? false;
  }
  const mic = participant.tracks.find((track) => track.source.toUpperCase().includes('MIC'));
  return mic === undefined ? null : mic.muted;
}

/**
 * Moderação da sala ao vivo.
 *
 * ## Por que esta aba não se parece com as outras
 *
 * As demais listam o BANCO, que muda devagar e pagina por keyset. Esta lista o
 * SFU, que muda a cada segundo e não tem paginação — uma sala tem dezenas de
 * pessoas, não milhares. Daí a atualização automática e a ausência de cursor.
 *
 * ## O que cada botão realmente faz
 *
 * Está escrito na tela, e não só aqui, porque a diferença importa para quem
 * clica: mutar é aplicado no servidor mas a pessoa pode religar o microfone;
 * remover desconecta mas não impede a volta, já que entrar não exige conta.
 * Prometer "banir" num botão que não bane seria a pior forma de errar aqui.
 */
export function AdminLive(): JSX.Element {
  const [rooms, setRooms] = useState<LiveRoom[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [people, setPeople] = useState<LiveParticipant[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [destino, setDestino] = useState('');

  const selectedRoom = rooms?.find((room) => room.slug === selected) ?? null;
  const selectedTransport = selectedRoom?.transport ?? 'LIVEKIT';
  const socketRef = useRef<Socket<ServerToClientPresenceEvents, ClientToServerPresenceEvents> | null>(null);

  const loadRooms = useCallback(async (signal?: AbortSignal) => {
    try {
      const list = await fetchLiveRooms(signal);
      setRooms(list);
      setFailure(null);
      return list;
    } catch (error) {
      if (signal?.aborted !== true) {
        setFailure(error instanceof ApiError ? error.message : 'Não deu para ler as salas ativas.');
        setRooms([]);
      }
      return [];
    }
  }, []);

  const loadPeople = useCallback(
    async (slug: string, transport: LiveRoom['transport'], signal?: AbortSignal) => {
      try {
        setPeople(await fetchLiveParticipants(slug, transport, signal));
      } catch (error) {
        if (signal?.aborted !== true) {
          setFailure(error instanceof ApiError ? error.message : 'Não deu para ler os participantes.');
          setPeople([]);
        }
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadRooms(controller.signal);
    const timer = window.setInterval(() => void loadRooms(), REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [loadRooms]);

  useEffect(() => {
    if (selected === null || selectedRoom === null) {
      setPeople(null);
      return;
    }
    const controller = new AbortController();
    void loadPeople(selected, selectedTransport, controller.signal);
    // O polling continua como fallback de reconexão/primeira carga (e é a
    // única fonte para LiveKit, que não tem canal de presença); para
    // mediasoup, quem dá a sensação de "ao vivo" agora é `roster:update`
    // (ver os dois efeitos de socket abaixo).
    const timer = window.setInterval(() => void loadPeople(selected, selectedTransport), REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, selectedTransport, loadPeople]);

  /**
   * Um socket admin só, aberto enquanto o painel "Ao vivo" estiver montado —
   * não um por sala selecionada, porque o token de admin (ver
   * `signAdminPresenceToken`) não tem `roomSlug` fixo e o painel troca de
   * sala sem pedir token novo (`admin:watch`/`admin:unwatch` abaixo cuidam
   * disso). `roster:update` atualiza `people` na hora e recalcula a
   * contagem da linha correspondente em `rooms`, sem esperar o próximo tick
   * de `REFRESH_MS`.
   */
  useEffect(() => {
    let cancelled = false;
    void fetchAdminPresenceToken()
      .then(({ token }) => {
        if (cancelled) return;
        const socket: Socket<ServerToClientPresenceEvents, ClientToServerPresenceEvents> = io(
          MEDIASOUP_PUBLIC_URL,
          { path: '/presence', auth: { token }, reconnection: true },
        );
        socket.on('roster:update', (update: PresenceRosterUpdate) => {
          setPeople((current) => {
            if (current === null) return current;
            // Só aplica se a sala assistida ainda for a selecionada — evita
            // uma resposta atrasada de uma sala anterior sobrescrever a atual.
            return update.roomSlug === selected
              ? update.peers.map((peer) => rosterEntryToParticipant(peer, current))
              : current;
          });
          setRooms((current) =>
            current === null
              ? current
              : current.map((room) =>
                  room.slug === update.roomSlug && room.transport === 'MEDIASOUP'
                    ? { ...room, participants: update.peers.length }
                    : room,
                ),
          );
        });
        socketRef.current = socket;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const socket = socketRef.current;
    if (socket === null || selected === null || selectedTransport !== 'MEDIASOUP') return;
    socket.emit('admin:watch', selected);
    return () => {
      socket.emit('admin:unwatch', selected);
    };
  }, [selected, selectedTransport]);

  const act = useCallback(
    async (identity: string, run: () => Promise<void>) => {
      setBusy(identity);
      setFailure(null);
      try {
        await run();
        if (selected !== null) await loadPeople(selected, selectedTransport);
        await loadRooms();
      } catch (error) {
        setFailure(error instanceof ApiError ? error.message : 'A ação não funcionou.');
      } finally {
        setBusy(null);
      }
    },
    [selected, selectedTransport, loadPeople, loadRooms],
  );

  const [deletingRoom, setDeletingRoom] = useState(false);
  const deleteRoom = useCallback(
    async (slug: string) => {
      setDeletingRoom(true);
      setFailure(null);
      try {
        await deleteLiveRoom(slug);
        setSelected(null);
        await loadRooms();
      } catch (error) {
        setFailure(error instanceof ApiError ? error.message : 'Não deu para apagar a sala.');
      } finally {
        setDeletingRoom(false);
      }
    },
    [loadRooms],
  );

  return (
    <div className={styles.card}>
      {failure !== null ? <p className={styles.error}>{failure}</p> : null}

      <div className={styles.filters}>
        <span className={styles.muted}>
          {rooms === null
            ? 'Carregando salas…'
            : rooms.length === 0
              ? 'Nenhuma sala com gente dentro agora.'
              : `${rooms.length} sala${rooms.length > 1 ? 's' : ''} ativa${rooms.length > 1 ? 's' : ''}`}
        </span>
        <button type="button" className={styles.ghost} onClick={() => void loadRooms()}>
          Atualizar
        </button>
      </div>

      {rooms !== null && rooms.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Sala</th>
                <th>Transporte</th>
                <th>Pessoas</th>
                <th>Aberta desde</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rooms.map((room) => (
                <tr key={`${room.transport}/${room.slug}`}>
                  <td>{room.slug}</td>
                  <td>
                    <span
                      className={styles.badgeSoft}
                      title={
                        room.transport === 'MEDIASOUP'
                          ? 'Servidor de mídia próprio (mediasoup)'
                          : 'LiveKit'
                      }
                    >
                      {room.transport === 'MEDIASOUP' ? 'mediasoup' : 'LiveKit'}
                    </span>
                  </td>
                  <td>{room.participants}</td>
                  <td>{formatWhen(room.createdAt)}</td>
                  <td>
                    <button
                      type="button"
                      className={styles.ghost}
                      onClick={() => setSelected(selected === room.slug ? null : room.slug)}
                      aria-expanded={selected === room.slug}
                    >
                      {selected === room.slug ? 'Fechar' : 'Ver quem está'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {selected !== null ? (
        <>
          <div className={styles.filters}>
            <h3 className={styles.subheading}>Quem está em {selected}</h3>
            {selectedTransport === 'MEDIASOUP' ? (
              <button
                type="button"
                className={styles.danger}
                disabled={deletingRoom}
                title="Desconecta todo mundo da sala agora. A sala continua existindo — só a sessão ao vivo acaba."
                onClick={() => void deleteRoom(selected)}
              >
                {deletingRoom ? 'Apagando…' : 'Apagar sala ao vivo'}
              </button>
            ) : null}
          </div>
          {selectedTransport === 'MEDIASOUP' ? (
            <p className={styles.muted}>
              Mutar e mover nesta sala dependem do navegador de quem está lá obedecer o pedido —
              o servidor mediasoup não impõe isso como o LiveKit. Remover e apagar a sala são reais.
            </p>
          ) : null}
          {people === null ? (
            <p className={styles.muted}>Carregando…</p>
          ) : people.length === 0 ? (
            <p className={styles.muted}>A sala esvaziou.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Pessoa</th>
                    <th>Entrou</th>
                    <th>Microfone</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((person) => {
                    const muted = isMicMuted(person);
                    const working = busy === person.identity;
                    return (
                      <tr key={person.identity}>
                        <td>
                          {person.displayName}
                          {person.isAnonymous ? (
                            <span className={styles.badgeSoft} title="Entrou sem conta">
                              anônimo
                            </span>
                          ) : null}
                        </td>
                        <td>{formatWhen(person.joinedAt)}</td>
                        <td>
                          {muted === null ? 'sem áudio' : muted ? 'mudo' : 'aberto'}
                        </td>
                        <td className={styles.actions}>
                          <button
                            type="button"
                            className={styles.ghost}
                            disabled={working || muted === null}
                            title={
                              muted === null
                                ? 'Essa pessoa não está publicando áudio'
                                : muted
                                  ? 'Devolver o microfone'
                                  : 'Silenciar agora. A pessoa pode religar.'
                            }
                            onClick={() =>
                              void act(person.identity, () =>
                                muteParticipant(selected, person.identity, muted !== true, selectedTransport),
                              )
                            }
                          >
                            {muted === true ? 'Desmutar' : 'Mutar'}
                          </button>

                          <button
                            type="button"
                            className={styles.ghost}
                            disabled={working}
                            onClick={() => {
                              setMoving(moving === person.identity ? null : person.identity);
                              setDestino('');
                            }}
                          >
                            Mover
                          </button>

                          <button
                            type="button"
                            className={styles.danger}
                            disabled={working}
                            title="Desconecta. Não impede a volta — para isso, suspenda a conta."
                            onClick={() =>
                              void act(person.identity, () =>
                                removeParticipant(selected, person.identity, selectedTransport),
                              )
                            }
                          >
                            Remover
                          </button>

                          {moving === person.identity ? (
                            <span className={styles.inlineForm}>
                              <input
                                className={styles.input}
                                value={destino}
                                onChange={(event) => setDestino(event.target.value)}
                                placeholder="sala de destino"
                                aria-label="Sala de destino"
                              />
                              <button
                                type="button"
                                className={styles.ghost}
                                disabled={working || destino.trim() === ''}
                                onClick={() =>
                                  void act(person.identity, async () => {
                                    await moveParticipant(
                                      selected,
                                      person.identity,
                                      destino.trim(),
                                      selectedTransport,
                                    );
                                    setMoving(null);
                                  })
                                }
                              >
                                Confirmar
                              </button>
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p className={styles.muted}>
            Mutar é aplicado no servidor, mas a pessoa pode religar o microfone. Remover
            desconecta e não impede a volta — entrar numa sala não exige conta. Para barrar
            de vez, suspenda a conta na aba Contas. Tudo aqui fica na auditoria.
          </p>
        </>
      ) : null}
    </div>
  );
}
