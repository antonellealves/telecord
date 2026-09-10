import type { ParticipantView } from '@telecord/shared';
import { MicIcon, MicOffIcon, MoonIcon } from './icons';
import styles from './ParticipantSidebar.module.css';

interface ParticipantSidebarProps {
  participants: ParticipantView[];
  /** Você está ausente agora. */
  isAway: boolean;
  /** Chamada em curso: o botão espera. */
  isAwayBusy: boolean;
  onToggleAway: () => void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part.charAt(0).toUpperCase()).join('') || '?';
}

function Row({ participant }: { participant: ParticipantView }): JSX.Element {
  return (
    <li
      className={[
        styles.row,
        participant.isSpeaking ? styles.speaking : '',
        participant.isMicrophoneEnabled ? '' : styles.muted,
        participant.isAway ? styles.awayRow : '',
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
      {/*
        * Ausente já significa microfone desligado, e o ícone de mutado ao lado
        * de todo mundo ali só repetiria o que a seção diz. A lua ocupa o lugar
        * e mantém a linha com o mesmo desenho das outras.
        */}
      {participant.isAway ? (
        <MoonIcon className={styles.icon} title="Ausente" />
      ) : participant.isMicrophoneEnabled ? (
        <MicIcon className={styles.icon} title="Microfone ligado" />
      ) : (
        <MicOffIcon className={styles.icon} title="Microfone mutado" />
      )}
    </li>
  );
}

/**
 * Lista lateral com indicador de quem fala e de quem está mutado (SPEC §5).
 *
 * Quem se marcou como ausente desce para uma seção própria no rodapé (§6.10).
 * Misturado à lista, um ausente parece disponível — alguém pergunta e espera
 * resposta. A seção existe também para quem NÃO está ausente: é onde fica o
 * botão de se marcar, e ali ele explica o que faz sem precisar de rótulo.
 */
export function ParticipantSidebar({
  participants,
  isAway,
  isAwayBusy,
  onToggleAway,
}: ParticipantSidebarProps): JSX.Element {
  const present = participants.filter((participant) => !participant.isAway);
  const away = participants.filter((participant) => participant.isAway);

  return (
    <aside className={styles.sidebar} aria-label="Participantes">
      <h2 className={styles.heading}>
        {/* A conta é da sala inteira: ausente continua na sala. */}
        Participantes <span className={styles.count}>{participants.length}</span>
      </h2>
      <ul className={styles.list}>
        {present.map((participant) => (
          <Row key={participant.identity} participant={participant} />
        ))}
      </ul>

      <section className={styles.away} aria-label="Ausentes">
        <div className={styles.awayHeader}>
          <h3 className={styles.awayHeading}>
            Ausentes {away.length > 0 ? <span className={styles.count}>{away.length}</span> : null}
          </h3>
          <button
            type="button"
            className={`${styles.awayToggle} ${isAway ? styles.awayToggleOn : ''}`}
            onClick={onToggleAway}
            disabled={isAwayBusy}
            aria-pressed={isAway}
            title={
              isAway
                ? 'Voltar para a lista. O microfone e a câmera continuam desligados.'
                : 'Desliga seu microfone e sua câmera e avisa a sala.'
            }
          >
            {isAway ? 'voltar' : 'ficar afk'}
          </button>
        </div>
        {away.length === 0 ? (
          <p className={styles.awayEmpty}>Ninguém ausente.</p>
        ) : (
          <ul className={styles.awayList}>
            {away.map((participant) => (
              <Row key={participant.identity} participant={participant} />
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
