import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScreenShareEntry } from '../hooks/useScreenShares';
import { ExpandIcon, ShrinkIcon } from './icons';
import styles from './ScreenStage.module.css';

interface ScreenStageProps {
  entries: ScreenShareEntry[];
}

/**
 * Um quadro de tela compartilhada.
 *
 * O elemento de vídeo é SEMPRE mudo. O áudio da tela chega pelo
 * RoomAudioRenderer, que só toca tracks remotas: se o vídeo também tocasse,
 * quem assiste ouviria dobrado e quem compartilha ouviria o próprio áudio
 * voltando.
 */
function ScreenTile({ entry }: { entry: ScreenShareEntry }): JSX.Element {
  const tileRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
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

  useEffect(() => {
    const handleChange = (): void => {
      setIsFullscreen(document.fullscreenElement === tileRef.current);
    };
    document.addEventListener('fullscreenchange', handleChange);
    return () => document.removeEventListener('fullscreenchange', handleChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const tile = tileRef.current;
    if (tile === null) {
      return;
    }
    if (document.fullscreenElement === tile) {
      void document.exitFullscreen();
    } else {
      // Safari em iPhone não implementa requestFullscreen em div; falhar aqui
      // não pode derrubar nada, então o erro é engolido de propósito.
      void tile.requestFullscreen?.().catch(() => undefined);
    }
  }, []);

  return (
    <div
      className={`${styles.tile} ${isFullscreen ? styles.tileFullscreen : ''}`}
      ref={tileRef}
    >
      <video ref={videoRef} className={styles.video} autoPlay playsInline muted />

      <span className={styles.label}>
        <span className={styles.live} aria-hidden="true" />
        {entry.owner.isLocal ? 'você' : entry.owner.displayName}
      </span>

      <button
        type="button"
        className={styles.expand}
        onClick={toggleFullscreen}
        title={isFullscreen ? 'Sair da tela cheia' : 'Ver em tela cheia'}
        aria-label={isFullscreen ? 'Sair da tela cheia' : 'Ver em tela cheia'}
      >
        {isFullscreen ? <ShrinkIcon /> : <ExpandIcon />}
      </button>
    </div>
  );
}

/** Palco: uma grade com todas as telas compartilhadas, ou o estado vazio. */
export function ScreenStage({ entries }: ScreenStageProps): JSX.Element {
  if (entries.length === 0) {
    return (
      <section className={styles.stage} aria-label="Telas compartilhadas">
        <div className={styles.empty}>
          <div className={styles.frame} aria-hidden="true" />
          <p className={styles.emptyTitle}>Ninguém está compartilhando a tela</p>
          <p className={styles.emptyHint}>
            Use o botão “Compartilhar tela” na barra abaixo. Mais de uma pessoa pode
            compartilhar ao mesmo tempo.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section
      className={`${styles.stage} ${styles.grid}`}
      data-count={Math.min(entries.length, 4)}
      aria-label="Telas compartilhadas"
    >
      {entries.map((entry) => (
        <ScreenTile key={entry.owner.trackSid} entry={entry} />
      ))}
    </section>
  );
}
