import { useCallback, useEffect, useState } from 'react';
import type { LiveParticipant, LiveRoom } from '@telecord/shared';
import {
  fetchLiveParticipants,
  fetchLiveRooms,
  moveParticipant,
  muteParticipant,
  removeParticipant,
} from '../lib/admin';
import { ApiError } from '../lib/apiClient';
import { formatWhen } from './AdminLogs';
import styles from './Admin.module.css';

/** Recarrega sozinho: quem entra e sai muda a cada segundo. */
const REFRESH_MS = 5000;

function isMicMuted(participant: LiveParticipant): boolean | null {
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

  const loadPeople = useCallback(async (slug: string, signal?: AbortSignal) => {
    try {
      setPeople(await fetchLiveParticipants(slug, signal));
    } catch (error) {
      if (signal?.aborted !== true) {
        setFailure(error instanceof ApiError ? error.message : 'Não deu para ler os participantes.');
        setPeople([]);
      }
    }
  }, []);

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
    if (selected === null) {
      setPeople(null);
      return;
    }
    const controller = new AbortController();
    void loadPeople(selected, controller.signal);
    const timer = window.setInterval(() => void loadPeople(selected), REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [selected, loadPeople]);

  const act = useCallback(
    async (identity: string, run: () => Promise<void>) => {
      setBusy(identity);
      setFailure(null);
      try {
        await run();
        if (selected !== null) await loadPeople(selected);
        await loadRooms();
      } catch (error) {
        setFailure(error instanceof ApiError ? error.message : 'A ação não funcionou.');
      } finally {
        setBusy(null);
      }
    },
    [selected, loadPeople, loadRooms],
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
                <th>Pessoas</th>
                <th>Aberta desde</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rooms.map((room) => (
                <tr key={room.slug}>
                  <td>{room.slug}</td>
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
          <h3 className={styles.subheading}>Quem está em {selected}</h3>
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
                                muteParticipant(selected, person.identity, muted !== true),
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
                                removeParticipant(selected, person.identity),
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
