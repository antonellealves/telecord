import { useEffect, type RefObject } from 'react';
import { SOUNDS } from '../lib/sounds';
import styles from './Soundboard.module.css';

interface SoundboardProps {
  /** Região que conta como "dentro" — inclui o botão que abre (ver DeviceSettings). */
  containerRef: RefObject<HTMLElement | null>;
  onPlay: (soundId: string) => void;
  onClose: () => void;
}

/**
 * Sons predefinidos, tocados para todo mundo na sala.
 *
 * O áudio não trafega: vai um aviso pelo canal de dados e cada cliente toca o
 * arquivo que já baixou de `public/sons`. Mandar o som como áudio custaria
 * banda por ouvinte e chegaria dessincronizado.
 */
export function Soundboard({ containerRef, onPlay, onClose }: SoundboardProps): JSX.Element {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    const handlePointerDown = (event: PointerEvent): void => {
      const container = containerRef.current;
      if (container !== null && event.target instanceof Node && !container.contains(event.target)) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKey);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [onClose, containerRef]);

  return (
    <div className={styles.panel} role="dialog" aria-label="Sons">
      <div className={styles.header}>
        <h2 className={styles.heading}>Sons</h2>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Fechar">
          ×
        </button>
      </div>

      <div className={styles.grid}>
        {SOUNDS.map((sound) => (
          <button
            key={sound.id}
            type="button"
            className={styles.sound}
            onClick={() => onPlay(sound.id)}
          >
            {sound.label}
          </button>
        ))}
      </div>

      <p className={styles.hint}>
        Todo mundo na sala ouve. Para trocar os sons, coloque os arquivos em{' '}
        <code className={styles.code}>apps/web/public/sons</code> e liste em{' '}
        <code className={styles.code}>lib/sounds.ts</code>.
      </p>
    </div>
  );
}
