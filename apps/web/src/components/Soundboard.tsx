import { useEffect, type RefObject } from 'react';
import { SOUNDS } from '../lib/sounds';
import { SpeakerIcon } from './icons';
import styles from './Soundboard.module.css';

interface SoundboardProps {
  /** Região que conta como "dentro" — inclui o botão que abre (ver DeviceSettings). */
  containerRef: RefObject<HTMLElement | null>;
  onPlay: (soundId: string) => void;
  onClose: () => void;
  /** 0..1, só para esta pessoa. */
  volume: number;
  muted: boolean;
  onVolumeChange: (volume: number) => void;
  onToggleMute: () => void;
}

/**
 * Sons predefinidos, tocados para todo mundo na sala.
 *
 * O áudio não trafega: vai um aviso pelo canal de dados e cada cliente toca o
 * arquivo que já baixou junto com o app. Mandar o som como áudio custaria
 * banda por ouvinte e chegaria dessincronizado.
 */
export function Soundboard({
  containerRef,
  onPlay,
  onClose,
  volume,
  muted,
  onVolumeChange,
  onToggleMute,
}: SoundboardProps): JSX.Element {
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
        {SOUNDS.length === 0 ? (
          <p className={styles.empty}>
            Nenhum som instalado. Largue arquivos de áudio em{' '}
            <code className={styles.code}>apps/web/src/assets/sons</code>.
          </p>
        ) : null}
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

      <div className={styles.volumeRow}>
        <button
          type="button"
          className={`${styles.mute} ${muted ? styles.muteOn : ''}`}
          onClick={onToggleMute}
          aria-pressed={muted}
          title={muted ? 'Voltar a ouvir os sons' : 'Silenciar os sons'}
        >
          <SpeakerIcon />
        </button>
        <input
          type="range"
          className={styles.slider}
          min={0}
          max={100}
          step={1}
          value={Math.round(volume * 100)}
          onChange={(event) => onVolumeChange(Number(event.target.value) / 100)}
          disabled={muted}
          aria-label="Volume dos sons"
        />
        <span className={styles.volumeValue}>{muted ? 'mudo' : `${Math.round(volume * 100)}%`}</span>
      </div>

      <p className={styles.hint}>
        O volume é só seu — cada pessoa ajusta o quanto ouve. Para acrescentar um som, largue o
        arquivo em <code className={styles.code}>apps/web/src/assets/sons</code> — o nome do arquivo
        vira o rótulo, sem precisar mexer no código.
      </p>
    </div>
  );
}
