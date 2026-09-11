import { createPortal } from 'react-dom';
import styles from './ParticipantOverlay.module.css';

export interface OverlayPerson {
  id: string;
  displayName: string;
  isSpeaking: boolean;
  isMuted: boolean;
  isLocal: boolean;
  /** Marcou-se como ausente; no modo direto ninguém marca, e fica falso. */
  isAway: boolean;
}

interface Props {
  /** Onde montar. `null` enquanto o overlay está fechado. */
  container: HTMLElement | null;
  people: OverlayPerson[];
  roomId: string;
  /** Âmbar no modo direto, azul no modo servidor — a mesma cor da sala. */
  variant: 'livekit' | 'p2p';
}

/**
 * Lista de quem está na sala, dentro da janela flutuante.
 *
 * Montado por portal numa janela de picture-in-picture de DOCUMENTO, que fica
 * acima de qualquer aplicativo — inclusive jogo em tela cheia. Ver `useOverlay`
 * para o porquê de não ser uma div com `position: fixed`.
 *
 * ## O que entra e o que fica de fora
 *
 * Entra: nome, quem está falando agora, quem está mudo, quem se marcou como
 * ausente. Fica de fora vídeo, chat e qualquer controle — a janela mede 260 px
 * e vive no canto da tela de alguém que está jogando. O trabalho dela é
 * responder "quem está falando?" num relance, e nada além disso.
 *
 * ## A marca de fala
 *
 * Barra lateral que acende, e não um ponto piscando: a barra acompanha a
 * altura do nome e é legível de canto de olho, que é como o overlay é visto.
 */
export function ParticipantOverlay({
  container,
  people,
  roomId,
  variant,
}: Props): JSX.Element | null {
  if (container === null) return null;

  const falando = people.filter((p) => p.isSpeaking).length;

  return createPortal(
    <div className={`${styles.overlay} ${variant === 'p2p' ? styles.p2p : ''}`}>
      <header className={styles.head}>
        <span className={styles.room}>{roomId}</span>
        <span className={styles.count}>
          {people.length} {people.length === 1 ? 'pessoa' : 'pessoas'}
        </span>
      </header>

      <ul className={styles.list}>
        {people.map((person) => (
          <li
            key={person.id}
            className={[
              styles.row,
              person.isSpeaking ? styles.speaking : '',
              person.isAway ? styles.away : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span className={styles.bar} aria-hidden="true" />
            <span className={styles.name}>
              {person.displayName}
              {person.isLocal ? <span className={styles.you}>você</span> : null}
            </span>
            {person.isMuted ? (
              <span className={styles.muted} title="Microfone desligado">
                ✕
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      {people.length === 0 ? <p className={styles.empty}>Ninguém na sala.</p> : null}

      <footer className={styles.foot}>
        {falando === 0 ? 'ninguém falando' : `${falando} falando`}
      </footer>
    </div>,
    container,
  );
}
