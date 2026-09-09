import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScreenShareEntry } from '../hooks/useScreenShares';
import { useZoomPan } from '../hooks/useZoomPan';
import { ExpandIcon, ShrinkIcon } from './icons';
import styles from './ScreenStage.module.css';

interface ScreenStageProps {
  entries: ScreenShareEntry[];
}

/** normal · tela cheia de verdade · maximizado dentro da página. */
type TileMode = 'normal' | 'fullscreen' | 'maximized';

/**
 * Um quadro de tela compartilhada, com zoom e tela cheia.
 *
 * O elemento de vídeo é SEMPRE mudo. O áudio da tela chega pelo
 * RoomAudioRenderer, que só toca tracks remotas: se o vídeo também tocasse,
 * quem assiste ouviria dobrado e quem compartilha ouviria o próprio áudio
 * voltando.
 */
function ScreenTile({ entry }: { entry: ScreenShareEntry }): JSX.Element {
  const tileRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [mode, setMode] = useState<TileMode>('normal');
  const zoom = useZoomPan();
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
      setMode((current) => {
        if (document.fullscreenElement === tileRef.current) return 'fullscreen';
        // Sair da tela cheia volta ao normal; não mexe em "maximizado", que é
        // um estado da página e não do navegador.
        return current === 'fullscreen' ? 'normal' : current;
      });
    };
    document.addEventListener('fullscreenchange', handleChange);
    return () => document.removeEventListener('fullscreenchange', handleChange);
  }, []);

  useEffect(() => {
    if (mode !== 'maximized') {
      return;
    }
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMode('normal');
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [mode]);

  /**
   * Tenta a tela cheia de verdade e cai para "maximizado" quando ela não
   * existe ou é recusada — iOS não implementa requestFullscreen em div, e
   * alguns contextos embutidos bloqueiam a API. Antes, a recusa era engolida
   * e o botão parecia morto.
   */
  const toggleExpand = useCallback(() => {
    const tile = tileRef.current;
    if (tile === null) {
      return;
    }
    if (mode === 'fullscreen') {
      void document.exitFullscreen().catch(() => setMode('normal'));
      return;
    }
    if (mode === 'maximized') {
      setMode('normal');
      return;
    }
    if (typeof tile.requestFullscreen === 'function') {
      void tile.requestFullscreen().catch(() => setMode('maximized'));
      return;
    }
    setMode('maximized');
  }, [mode]);

  const isExpanded = mode !== 'normal';

  return (
    <div
      className={[
        styles.tile,
        mode === 'fullscreen' ? styles.tileFullscreen : '',
        mode === 'maximized' ? styles.tileMaximized : '',
      ]
        .filter(Boolean)
        .join(' ')}
      ref={tileRef}
    >
      <div
        className={styles.viewport}
        ref={zoom.viewportRef}
        onDoubleClick={toggleExpand}
        title="Role para ampliar · arraste para mover · duplo clique para tela cheia"
      >
        <div className={styles.surface} ref={zoom.contentRef}>
          <video ref={videoRef} className={styles.video} autoPlay playsInline muted />
        </div>
      </div>

      <span className={styles.label}>
        <span className={styles.live} aria-hidden="true" />
        {entry.owner.isLocal ? 'você' : entry.owner.displayName}
      </span>

      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.tool}
          onClick={zoom.zoomOut}
          disabled={!zoom.canZoomOut}
          title="Diminuir"
          aria-label="Diminuir"
        >
          −
        </button>
        <button
          type="button"
          className={`${styles.tool} ${styles.level}`}
          onClick={zoom.reset}
          disabled={!zoom.canZoomOut}
          title="Voltar ao tamanho da tela"
        >
          {Math.round(zoom.scale * 100)}%
        </button>
        <button
          type="button"
          className={styles.tool}
          onClick={zoom.zoomIn}
          disabled={!zoom.canZoomIn}
          title="Ampliar"
          aria-label="Ampliar"
        >
          +
        </button>

        <span className={styles.divider} aria-hidden="true" />

        <button
          type="button"
          className={styles.tool}
          onClick={toggleExpand}
          title={isExpanded ? 'Sair da tela cheia (Esc)' : 'Ver em tela cheia'}
          aria-label={isExpanded ? 'Sair da tela cheia' : 'Ver em tela cheia'}
        >
          {isExpanded ? <ShrinkIcon /> : <ExpandIcon />}
        </button>
      </div>
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
