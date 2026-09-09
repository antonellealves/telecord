import type { RoomConnectionStatus } from '../hooks/useRoomConnection';
import styles from './ConnectionBanner.module.css';

const LABELS: Record<RoomConnectionStatus, string> = {
  connecting: 'Conectando…',
  connected: 'Conectado',
  reconnecting: 'Reconectando…',
  disconnected: 'Desconectado',
};

/** Feedback visível de cada estado de conexão (SPEC §5). */
export function ConnectionBanner({ status }: { status: RoomConnectionStatus }): JSX.Element {
  return (
    <div className={`${styles.banner} ${styles[status]}`} role="status" aria-live="polite">
      <span className={styles.dot} aria-hidden="true" />
      {LABELS[status]}
    </div>
  );
}
