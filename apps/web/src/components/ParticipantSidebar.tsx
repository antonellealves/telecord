import type { ParticipantView } from '@telecord/shared';
import { MicIcon, MicOffIcon } from './icons';
import styles from './ParticipantSidebar.module.css';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part.charAt(0).toUpperCase()).join('') || '?';
}

/** Lista lateral com indicador de quem fala e de quem está mutado (SPEC §5). */
export function ParticipantSidebar({ participants }: { participants: ParticipantView[] }): JSX.Element {
  return (
    <aside className={styles.sidebar} aria-label="Participantes">
      <h2 className={styles.heading}>
        Participantes <span className={styles.count}>{participants.length}</span>
      </h2>
      <ul className={styles.list}>
        {participants.map((participant) => (
          <li
            key={participant.identity}
            className={[
              styles.row,
              participant.isSpeaking ? styles.speaking : '',
              participant.isMicrophoneEnabled ? '' : styles.muted,
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span className={styles.avatar} aria-hidden="true">
              {initials(participant.displayName)}
            </span>
            <span className={styles.name} title={participant.displayName}>
              {participant.displayName}
              {participant.isLocal ? <span className={styles.you}> (você)</span> : null}
            </span>
            {participant.isSharingScreen ? (
              <span className={`${styles.badge} ${styles.sharing}`}>tela</span>
            ) : null}
            {participant.isMicrophoneEnabled ? (
              <MicIcon className={styles.icon} title="Microfone ligado" />
            ) : (
              <MicOffIcon className={styles.icon} title="Microfone mutado" />
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
