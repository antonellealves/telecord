import { useEffect, useState } from 'react';
import type { ActiveRoom } from '@telecord/shared';
import { RefreshIcon } from './icons';
import styles from './ActiveRoomsList.module.css';

/*
 * Uma volta inteira do ícone. O mesmo número está no CSS: é o que garante que
 * a animação nunca pare no meio de um giro.
 */
const SPIN_MS = 700;

interface ActiveRoomsListProps {
  rooms: ActiveRoom[];
  isLoading: boolean;
  error: string | null;
  onEnter: (roomId: string) => void;
  onRefresh: () => void;
}

function since(startedAt: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - startedAt) / 60000));
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `há ${hours} h`;
}

export function ActiveRoomsList({
  rooms,
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

  return (
    <section className={styles.block} aria-label="Salas ativas">
      <div className={styles.header}>
        <h2 className={styles.heading}>
          Salas ativas {rooms.length > 0 ? <span className={styles.count}>{rooms.length}</span> : null}
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
      ) : rooms.length === 0 ? (
        <p className={styles.message}>
          {isLoading ? 'Procurando…' : 'Nenhuma sala com gente agora. Crie a sua acima.'}
        </p>
      ) : (
        <ul className={styles.list}>
          {rooms.map((room) => (
            <li key={room.roomId}>
              <button type="button" className={styles.room} onClick={() => onEnter(room.roomId)}>
                <span className={styles.name}>{room.roomId}</span>
                <span className={styles.meta}>
                  <span className={styles.people}>
                    <span className={styles.dot} aria-hidden="true" />
                    {room.participants}
                  </span>
                  <span className={styles.age}>{since(room.startedAt)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
