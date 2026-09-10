import { useEffect, useMemo, useState } from 'react';
import type { ActiveRoom, RoomSummary } from '@telecord/shared';
import { RefreshIcon } from './icons';
import styles from './ActiveRoomsList.module.css';

/*
 * Uma volta inteira do ícone. O mesmo número está no CSS: é o que garante que
 * a animação nunca pare no meio de um giro.
 */
const SPIN_MS = 700;

/** Quantas salas nomeadas e vazias listar. Além disso vira catálogo. */
const QUIET_LIMIT = 6;

interface ActiveRoomsListProps {
  rooms: ActiveRoom[];
  /** Salas com nome, vindas do banco. Vazio quando não há serviço de contas. */
  directory: RoomSummary[];
  isLoading: boolean;
  error: string | null;
  onEnter: (roomId: string) => void;
  onRefresh: () => void;
}

/** Uma linha da lista, já com as duas fontes casadas. */
interface Entry {
  slug: string;
  /** Nome legível, quando a sala foi batizada. */
  title: string | null;
  emoji: string | null;
  participants: number;
  startedAt: number | null;
  soundCount: number;
}

function since(startedAt: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - startedAt) / 60000));
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `há ${hours} h`;
}

/**
 * Onde entrar: as salas com gente agora e as que têm nome.
 *
 * As duas listas vêm de fontes diferentes e nenhuma responde sozinha. O
 * LiveKit sabe quem está conversando neste instante, mas só conhece o slug; o
 * banco sabe que `dota-teleton` se chama "Dota da madrugada" e quantos sons
 * tem, mas não sabe se há alguém lá. Casar as duas é o que faz a lista dizer
 * "Dota da madrugada, 4 pessoas" em vez de "dota-teleton, 4".
 *
 * A ordem é por movimento: quem tem gente vem primeiro, e as salas nomeadas e
 * vazias ficam embaixo — são o atalho para voltar a um lugar conhecido, não o
 * convite principal.
 *
 * Sem serviço de contas, `directory` chega vazio e a lista é exatamente a que
 * existia antes de haver banco.
 */
export function ActiveRoomsList({
  rooms,
  directory,
  isLoading,
  error,
  onEnter,
  onRefresh,
}: ActiveRoomsListProps): JSX.Element {
  /*
   * Giro mínimo de uma volta, independente da resposta. A lista costuma voltar
   * em poucos milissegundos e, preso só ao `isLoading`, o ícone dava um
   * espasmo — o clique parecia não ter feito nada.
   */
  const [spinning, setSpinning] = useState(false);

  useEffect(() => {
    if (!spinning) return undefined;
    const timer = window.setTimeout(() => setSpinning(false), SPIN_MS);
    return () => window.clearTimeout(timer);
  }, [spinning]);

  const isSpinning = spinning || isLoading;

  const { live, quiet } = useMemo(() => {
    const named = new Map(directory.map((room) => [room.slug, room]));

    const liveEntries: Entry[] = rooms.map((room) => {
      const details = named.get(room.roomId);
      return {
        slug: room.roomId,
        title: details?.name ?? null,
        emoji: details?.emoji ?? null,
        participants: room.participants,
        startedAt: room.startedAt,
        soundCount: details?.soundCount ?? 0,
      };
    });

    const busy = new Set(rooms.map((room) => room.roomId));
    const quietEntries: Entry[] = directory
      .filter((room) => !busy.has(room.slug))
      .slice(0, QUIET_LIMIT)
      .map((room) => ({
        slug: room.slug,
        title: room.name,
        emoji: room.emoji,
        participants: 0,
        startedAt: null,
        soundCount: room.soundCount,
      }));

    return { live: liveEntries, quiet: quietEntries };
  }, [rooms, directory]);

  return (
    <section className={styles.block} aria-label="Salas">
      <div className={styles.header}>
        <h2 className={styles.heading}>
          Salas ativas {live.length > 0 ? <span className={styles.count}>{live.length}</span> : null}
        </h2>
        <button
          type="button"
          className={`${styles.refresh} ${isSpinning ? styles.spinning : ''}`}
          onClick={() => {
            setSpinning(true);
            onRefresh();
          }}
          disabled={isLoading}
          title={isLoading ? 'Procurando salas…' : 'Atualizar a lista'}
          aria-label="Atualizar a lista de salas"
        >
          <RefreshIcon />
        </button>
      </div>

      {error !== null ? (
        <p className={styles.message}>{error}</p>
      ) : live.length === 0 && quiet.length === 0 ? (
        <p className={styles.message}>
          {isLoading ? 'Procurando…' : 'Nenhuma sala com gente agora. Crie a sua acima.'}
        </p>
      ) : (
        <ul className={styles.list}>
          {live.map((entry) => (
            <RoomRow key={entry.slug} entry={entry} onEnter={onEnter} />
          ))}
          {quiet.length > 0 ? (
            <li className={styles.divider} aria-hidden="true">
              com nome, sem ninguém agora
            </li>
          ) : null}
          {quiet.map((entry) => (
            <RoomRow key={entry.slug} entry={entry} onEnter={onEnter} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RoomRow({ entry, onEnter }: { entry: Entry; onEnter: (slug: string) => void }): JSX.Element {
  return (
    <li>
      <button
        type="button"
        className={`${styles.room} ${entry.participants === 0 ? styles.quiet : ''}`}
        onClick={() => onEnter(entry.slug)}
      >
        <span className={styles.identity}>
          {entry.emoji !== null ? (
            <span className={styles.emoji} aria-hidden="true">
              {entry.emoji}
            </span>
          ) : null}
          <span className={styles.names}>
            <span className={styles.name}>{entry.title ?? entry.slug}</span>
            {/* O slug embaixo quando há nome: é ele que aparece na URL, e é
                por ele que alguém chama a sala em voz alta. */}
            {entry.title !== null ? <span className={styles.slug}>/{entry.slug}</span> : null}
          </span>
        </span>
        <span className={styles.meta}>
          {entry.soundCount > 0 ? (
            <span className={styles.sounds} title={`${entry.soundCount} sons próprios`}>
              ♪ {entry.soundCount}
            </span>
          ) : null}
          {entry.participants > 0 ? (
            <span className={styles.people}>
              <span className={styles.dot} aria-hidden="true" />
              {entry.participants}
            </span>
          ) : null}
          {entry.startedAt !== null ? (
            <span className={styles.age}>{since(entry.startedAt)}</span>
          ) : null}
        </span>
      </button>
    </li>
  );
}
