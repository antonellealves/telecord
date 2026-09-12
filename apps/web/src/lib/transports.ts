import type { TransportMode } from '@telecord/shared';
import { P2P_COMFORT_PEERS } from '@telecord/shared';
import { CloudIcon, MeshIcon, RelayIcon, ServerIcon } from '../components/icons';

interface IconProps {
  className?: string;
}

/**
 * Registro central dos modos de transmissão.
 *
 * Uma única fonte de verdade para as quatro opções: id, nome curto, ícone e o
 * que se ganha/perde. A UI (cartões na entrada, seletor na sala) lê daqui e
 * NÃO tem lógica por modo espalhada — acrescentar um quinto transporte é uma
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
    id: 'p2p',
    label: 'Direto',
    tagline: 'WebRTC puro · experimental',
    Icon: MeshIcon,
    pros: ['Latência menor', 'Nenhum servidor vê a mídia'],
    cons: [`Pesa acima de ${P2P_COMFORT_PEERS} pessoas`, 'Algumas redes não deixam conectar'],
  },
  {
    id: 'cfsfu',
    label: 'Cloudflare',
    tagline: 'Cloudflare Realtime · experimental',
    Icon: CloudIcon,
    pros: ['Baixa latência', 'Qualidade máxima', 'Rede global'],
    cons: ['Free tier da Cloudflare', 'Consome banda de quem assiste'],
  },
  {
    id: 'vercel-relay',
    label: 'Vercel Relay',
    tagline: 'WebCodecs na Vercel · experimental',
    Icon: RelayIcon,
    experimental: true,
    pros: ['Zero infraestrutura', 'HD via WebCodecs', 'Tudo na Vercel'],
    cons: ['Relay best-effort de instância única', 'Em construção'],
  },
];

export function transportInfo(id: TransportMode): TransportInfo {
  return TRANSPORTS.find((transport) => transport.id === id) ?? TRANSPORTS[0]!;
}
