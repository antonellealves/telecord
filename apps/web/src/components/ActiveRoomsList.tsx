import type { ActiveRoom } from '@telecord/shared';
import styles from './ActiveRoomsList.module.css';

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
  return (
    <section className={styles.block} aria-label="Salas ativas">
      <div className={styles.header}>
        <h2 className={styles.heading}>
          Salas ativas {rooms.length > 0 ? <span className={styles.count}>{rooms.length}</span> : null}
        </h2>
        <button type="button" className={styles.refresh} onClick={onRefresh} disabled={isLoading}>
          {isLoading ? 'carregando…' : 'atualizar'}
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
