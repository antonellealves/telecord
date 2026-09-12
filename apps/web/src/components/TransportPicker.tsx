import { useId } from 'react';
import type { TransportMode } from '@telecord/shared';
import { TRANSPORTS } from '../lib/transports';
import styles from './TransportPicker.module.css';

interface Props {
  value: TransportMode;
  onChange: (mode: TransportMode) => void;
  /** Só o ícone, sem o nome ao lado (dentro da sala). */
  compact?: boolean;
  /** Opções a esconder — ex.: `['cfsfu']` quando o Cloudflare está desligado. */
  hidden?: TransportMode[];
}

/**
 * Escolha do modo de transmissão — discreta, movida a ícones.
 *
 * Antes eram cartões grandes com prós e contras sempre à vista, que tomavam
 * meia tela. Agora é uma fileira de ícones pequenos com o nome curto; os prós e
 * contras (que continuam pesando igual, sem esconder o custo) aparecem num
 * tooltip ao passar o mouse ou focar — mesmo padrão do "i" do soundboard.
 *
 * O conteúdo vem todo do `TRANSPORTS` (registry): esta é só a apresentação, e
 * um quinto modo entra sem tocar aqui.
 */
export function TransportPicker({ value, onChange, compact = false, hidden }: Props): JSX.Element {
  const baseId = useId();
  const visible = TRANSPORTS.filter((transport) => !(hidden ?? []).includes(transport.id));

  return (
    <div
      className={`${styles.wrap} ${compact ? styles.compact : ''}`}
      role="radiogroup"
      aria-label="Como a transmissão viaja"
    >
      {visible.map((transport) => {
        const selected = value === transport.id;
        const tipId = `${baseId}-${transport.id}`;
        const { Icon } = transport;
        return (
          <div key={transport.id} className={styles.item}>
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              aria-describedby={tipId}
              className={`${styles.option} ${selected ? styles.optionOn : ''}`}
              onClick={() => onChange(transport.id)}
            >
              <Icon className={styles.icon} />
              {compact ? null : <span className={styles.label}>{transport.label}</span>}
            </button>

            <span id={tipId} role="tooltip" className={styles.tip}>
              <span className={styles.tipHead}>
                {transport.label}
                {transport.experimental ? <span className={styles.tag}>em construção</span> : null}
              </span>
              <span className={styles.tagline}>{transport.tagline}</span>
              <span className={styles.lists}>
                {transport.pros.map((item) => (
                  <span key={item} className={styles.pro}>
                    {item}
                  </span>
                ))}
                {transport.cons.map((item) => (
                  <span key={item} className={styles.con}>
                    {item}
                  </span>
                ))}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
