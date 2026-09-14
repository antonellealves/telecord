import styles from '../../components/AudioPlaybackGate.module.css';

interface Props {
  blocked: boolean;
  onUnblock: () => void;
}

/**
 * Equivalente ao `AudioPlaybackGate` do LiveKit, para o transporte
 * mediasoup — mesmo aviso e mesmo CSS, mas alimentado por props em vez de
 * `useAudioPlaybackBlocked` (que chama `useRoomContext()` e lança fora de um
 * `<LiveKitRoom>`). O estado vem de `useMediasoupPeerVolume`, dono do
 * `AudioContext` que este botão desbloqueia.
 */
export function MediasoupAudioPlaybackGate({ blocked, onUnblock }: Props): JSX.Element | null {
  if (!blocked) return null;

  return (
    <div className={styles.gate} role="alert">
      <span>O navegador bloqueou o áudio até você interagir com a página.</span>
      <button type="button" className={styles.button} onClick={onUnblock}>
        Ativar áudio
      </button>
    </div>
  );
}
