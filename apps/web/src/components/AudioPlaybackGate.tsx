import { useAudioPlaybackBlocked } from '../hooks/useRoomConnection';
import styles from './AudioPlaybackGate.module.css';

/**
 * A política de autoplay bloqueia áudio até o primeiro gesto do usuário. Sem
 * este botão o sintoma é "entrei e não escuto ninguém" — e sem erro nenhum.
 */
export function AudioPlaybackGate(): JSX.Element | null {
  const { blocked, unblock } = useAudioPlaybackBlocked();

  if (!blocked) {
    return null;
  }

  return (
    <div className={styles.gate} role="alert">
      <span>O navegador bloqueou o áudio até você interagir com a página.</span>
      <button type="button" className={styles.button} onClick={unblock}>
        Ativar áudio
      </button>
    </div>
  );
}
