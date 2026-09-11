import type { TransportMode } from '@telecord/shared';
import { P2P_COMFORT_PEERS } from '@telecord/shared';
import styles from './TransportPicker.module.css';

interface Props {
  value: TransportMode;
  onChange: (mode: TransportMode) => void;
  /** Some com o texto longo onde não cabe (dentro da sala, por exemplo). */
  compact?: boolean;
}

interface Option {
  id: TransportMode;
  label: string;
  tagline: string;
  /** O que se ganha. */
  pros: string[];
  /** O que se perde — e isto NÃO é letra miúda. */
  cons: string[];
}

/*
 * As duas opções, descritas pelo que custam e não só pelo que entregam.
 *
 * Um seletor que só elogia as duas pontas empurra a decisão para quem não tem
 * como decidir: "direto" soa melhor que "servidor" para qualquer pessoa, e
 * quem escolher P2P numa sala de dez vai ter uma experiência ruim achando que
 * o app é ruim. O limite e a dependência de rede aparecem no mesmo tamanho das
 * vantagens.
 */
const OPTIONS: Option[] = [
  {
    id: 'livekit',
    label: 'Servidor de mídia',
    tagline: 'LiveKit · padrão',
    pros: ['Sala cheia sem pesar', 'Funciona em qualquer rede', 'Chat, sons e gravação'],
    cons: ['A mídia passa por um servidor'],
  },
  {
    id: 'p2p',
    label: 'Conexão direta',
    tagline: 'WebRTC puro · experimental',
    pros: ['Latência menor', 'Nenhum servidor vê a mídia'],
    cons: [`Pesa acima de ${P2P_COMFORT_PEERS} pessoas`, 'Algumas redes não deixam conectar'],
  },
];

/**
 * Escolha do paradigma de transmissão.
 *
 * Fica em evidência, e não escondido nas configurações, porque muda o que a
 * sala É: quantas pessoas cabem, por onde a mídia anda e o que funciona
 * dentro dela. É uma decisão de produto, não uma preferência de dispositivo.
 */
export function TransportPicker({ value, onChange, compact = false }: Props): JSX.Element {
  return (
    <div
      className={`${styles.wrap} ${compact ? styles.compact : ''}`}
      role="radiogroup"
      aria-label="Como a transmissão viaja"
    >
      {OPTIONS.map((option) => {
        const selected = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`${styles.option} ${selected ? styles.optionOn : ''}`}
            onClick={() => onChange(option.id)}
          >
            <span className={styles.head}>
              <span className={styles.mark} aria-hidden="true" />
              <span className={styles.label}>{option.label}</span>
            </span>
            <span className={styles.tagline}>{option.tagline}</span>

            {compact ? null : (
              <span className={styles.lists}>
                {option.pros.map((item) => (
                  <span key={item} className={styles.pro}>
                    {item}
                  </span>
                ))}
                {option.cons.map((item) => (
                  <span key={item} className={styles.con}>
                    {item}
                  </span>
                ))}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
