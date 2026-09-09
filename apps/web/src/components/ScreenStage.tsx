import { useEffect, useRef } from 'react';
import type { ScreenShareEntry } from '../hooks/useScreenShareLock';
import styles from './ScreenStage.module.css';

interface ScreenStageProps {
  entry: ScreenShareEntry | null;
}

/**
 * Área principal: a tela compartilhada, ou o estado vazio.
 *
 * A track é anexada e desanexada à mão para garantir a limpeza no unmount e
 * na troca de apresentador. O elemento fica sempre mudo: o áudio da tela sai
 * pelo RoomAudioRenderer, e tocá-lo aqui também causaria eco.
 */
export function ScreenStage({ entry }: ScreenStageProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const track = entry?.publication.track ?? null;

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

  if (entry === null) {
    return (
      <section className={styles.stage} aria-label="Tela compartilhada">
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Ninguém está compartilhando a tela</p>
          <p className={styles.emptyHint}>
            Use o botão “Compartilhar tela” na barra abaixo. Só uma pessoa por vez.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.stage} aria-label="Tela compartilhada">
      <video ref={videoRef} className={styles.video} autoPlay playsInline muted />
      <span className={styles.label}>
        {entry.owner.isLocal ? 'Você está compartilhando' : `${entry.owner.displayName} está compartilhando`}
      </span>
    </section>
  );
}
