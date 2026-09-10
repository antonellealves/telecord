import { SpeakerIcon } from './icons';
import styles from './PeerVolumeControl.module.css';

interface PeerVolumeControlProps {
  volume: number;
  muted: boolean;
  onVolumeChange: (volume: number) => void;
  onToggleMuted: () => void;
  /** Nome de quem aparece no rótulo do controle, para leitor de tela. */
  displayName: string;
}

/**
 * Slider de volume individual: 0% a 200%, com mudo à parte.
 *
 * Compartilhado por dois lugares que precisam da MESMA lógica com visual
 * diferente — a linha da `ParticipantSidebar` e o popover que o nome no chat
 * abre (ver `usePeerVolume`). Duplicar o slider seria duplicar também a faixa
 * de 0 a 200, o formato do rótulo e a semântica de "mudo lembra o valor
 * anterior" — o tipo de coisa que diverge sem ninguém perceber.
 *
 * A metade 100–200% é visualmente distinta (a trilha muda de cor): é o
 * "enhancement", e sem marcação ninguém saberia, olhando o controle, que
 * passou de "volume normal" para "reforçado além do que o microfone da
 * pessoa manda".
 */
export function PeerVolumeControl({
  volume,
  muted,
  onVolumeChange,
  onToggleMuted,
  displayName,
}: PeerVolumeControlProps): JSX.Element {
  const percent = Math.round(volume * 100);
  const boosted = volume > 1;

  return (
    <div className={styles.control}>
      <button
        type="button"
        className={`${styles.mute} ${muted ? styles.muteOn : ''}`}
        onClick={onToggleMuted}
        aria-pressed={muted}
        title={muted ? `Voltar a ouvir ${displayName}` : `Silenciar ${displayName}`}
      >
        <SpeakerIcon />
      </button>
      <input
        type="range"
        className={`${styles.slider} ${boosted ? styles.boosted : ''}`}
        min={0}
        max={200}
        step={5}
        value={percent}
        onChange={(event) => onVolumeChange(Number(event.target.value) / 100)}
        disabled={muted}
        aria-label={`Volume de ${displayName}`}
        // O meio da faixa (100%) fica marcado na trilha — é onde "reforçar"
        // começa. `list` + `datalist` é semântico e não pesa nada em JS.
        list="peer-volume-scale"
      />
      <span className={`${styles.value} ${boosted ? styles.boostedValue : ''}`}>
        {muted ? 'mudo' : `${percent}%`}
      </span>
    </div>
  );
}

/**
 * A marca dos 100% na trilha, uma vez só no documento. `<datalist>` é
 * referenciado por `list=` em qualquer `<input range>` da página — não
 * precisa de uma cópia por controle.
 */
export function PeerVolumeScale(): JSX.Element {
  return (
    <datalist id="peer-volume-scale">
      <option value={100} />
    </datalist>
  );
}
