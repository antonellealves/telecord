import { useEffect, useRef } from 'react';
import type { CameraEntry } from '../hooks/useCameras';
import styles from './CameraStrip.module.css';

interface CameraStripProps {
  entries: CameraEntry[];
  /** Sem tela compartilhada, as câmeras ficam com o palco inteiro. */
  expanded: boolean;
}

/**
 * Um quadro de câmera.
 *
 * `object-fit: cover` em vez de `contain`: rosto em quadro pequeno com tarja
 * preta em cima e embaixo desperdiça justamente o espaço que já é pouco.
 * O próprio vídeo é espelhado — é o que a pessoa espera ver de si mesma; os
 * dos outros, não, senão texto e lateralidade aparecem invertidos.
 */
function CameraTile({ entry }: { entry: CameraEntry }): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const track = entry.publication.track ?? null;

  useEffect(() => {
    const element = videoRef.current;
    if (element === null || track === null) {
      return;
    }
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [track]);

  return (
    <div className={`${styles.tile} ${entry.isSpeaking ? styles.speaking : ''}`}>
      <video
        ref={videoRef}
        className={`${styles.video} ${entry.isLocal ? styles.mirrored : ''}`}
        autoPlay
        playsInline
        muted
      />
      <span className={styles.name}>{entry.isLocal ? 'você' : entry.displayName}</span>
    </div>
  );
}

/** Faixa de câmeras, acima das telas compartilhadas. */
export function CameraStrip({ entries, expanded }: CameraStripProps): JSX.Element | null {
  if (entries.length === 0) {
    return null;
  }

  return (
    <div
      className={`${styles.strip} ${expanded ? styles.expanded : ''}`}
      aria-label="Câmeras"
    >
      {entries.map((entry) => (
        <CameraTile key={entry.trackSid} entry={entry} />
      ))}
    </div>
  );
}
