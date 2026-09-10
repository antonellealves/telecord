import { useEffect, type RefObject } from 'react';
import { SOUNDS } from '../lib/sounds';
import { SpeakerIcon, StopIcon } from './icons';
import styles from './Soundboard.module.css';

interface SoundboardProps {
  /** Região que conta como "dentro" — inclui o botão que abre (ver DeviceSettings). */
  containerRef: RefObject<HTMLElement | null>;
  onPlay: (soundId: string) => void;
  /** Som tocando agora, ou null. Só um por vez. */
  playingSoundId: string | null;
  /** Corta o som para a sala inteira. */
  onStop: (soundId: string) => void;
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
 *
 * Parar também é um aviso, não um gesto local: quem corta um clipe longo corta
 * para todos, que é o motivo de existir o botão. Silenciar só para si é o que
 * o controle de volume já faz.
 *
 * Enquanto um som toca, o card dele significa parar, não tocar de novo — ver o
 * comentário no botão.
 */
export function Soundboard({
  containerRef,
  onPlay,
  playingSoundId,
  onStop,
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
        {SOUNDS.map((sound) => {
          const isPlaying = sound.id === playingSoundId;
          return (
            /*
             * O parar é um botão irmão, não filho: botão dentro de botão é HTML
             * inválido e o clique de dentro não chega de forma confiável.
             */
            <div
              key={sound.id}
              className={`${styles.tile} ${isPlaying ? styles.playing : ''}`}
            >
              {isPlaying ? (
                <button
                  type="button"
                  className={styles.stop}
                  onClick={() => onStop(sound.id)}
                  title={`Parar "${sound.label}" para todos`}
                  aria-label={`Parar ${sound.label}`}
                >
                  <StopIcon />
                </button>
              ) : null}
              {/*
                * Tocando, o card inteiro passa a ser "parar".
                *
                * O selo de parar tem 22px em cima de um card de 100x66 que era
                * todo "tocar": errar o alvo por poucos pixels não fazia nada
                * silencioso, re-disparava o som — que é indistinguível de
                * "apertei parar e continuou tocando". Um controle com dois
                * estados, como play/pause, não tem esse modo de falha.
                */}
              <button
                type="button"
                className={styles.sound}
                onClick={() => (isPlaying ? onStop(sound.id) : onPlay(sound.id))}
                aria-pressed={isPlaying}
                title={
                  isPlaying
                    ? `Parar "${sound.label}" para todos`
                    : `Tocar "${sound.label}" para a sala`
                }
              >
                {sound.label}
              </button>
            </div>
          );
        })}
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
