import type { TransportMode } from '@telecord/shared';
import { LayersIcon, ServerIcon } from '../components/icons';

interface IconProps {
  className?: string;
}

/**
 * Registro central dos modos de transmissão.
 *
 * Uma única fonte de verdade para as duas opções: id, nome curto, ícone e o
 * que se ganha/perde. A UI (cartões na entrada, seletor na sala) lê daqui e
 * NÃO tem lógica por modo espalhada — acrescentar um novo transporte é uma
 * linha nesta lista, sem tocar em componente nenhum. É o que o pedido chama de
 * `streamTransportRegistry`.
 */
export interface TransportInfo {
  id: TransportMode;
  /** Nome curto, para o cartão discreto. */
  label: string;
  /** Uma linha, para o tooltip. */
  tagline: string;
  /** O que se ganha. */
  pros: string[];
  /** O que se perde — no mesmo peso, sem letra miúda. */
  cons: string[];
  Icon: (props: IconProps) => JSX.Element;
  /** Ainda em construção: aparece na lista, mas o tooltip avisa. */
  experimental?: boolean;
}

export const TRANSPORTS: TransportInfo[] = [
  {
    id: 'livekit',
    label: 'Servidor',
    tagline: 'LiveKit · padrão',
    Icon: ServerIcon,
    pros: ['Sala cheia sem pesar', 'Funciona em qualquer rede', 'Chat, sons e gravação'],
    cons: ['A mídia passa por um servidor'],
  },
  {
    id: 'mediasoup',
    label: 'mediasoup',
    tagline: 'SFU próprio na VM · experimental',
    Icon: LayersIcon,
    experimental: true,
    pros: ['Servidor próprio, sem terceiro', 'Mesma VM do LiveKit', 'Controle total do roteamento'],
    cons: ['Depende de processo à parte na VM', 'Em construção'],
  },
];

export function transportInfo(id: TransportMode): TransportInfo {
  return TRANSPORTS.find((transport) => transport.id === id) ?? TRANSPORTS[0]!;
}
