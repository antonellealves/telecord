/**
 * Servidores de gelo (ICE) do modo direto, vistos do navegador.
 *
 * Busca a lista de `GET /api/ice` e a repassa CRUA para o `RTCPeerConnection` —
 * o formato do servidor já espelha o `RTCIceServer`. Se a busca falhar (servidor
 * antigo sem a rota, ou ambiente sem serviço de contas), cai no STUN público:
 * o modo direto continua de pé nas redes que STUN resolve, que são a maioria.
 */
import type { IceConfig } from '@telecord/shared';
import { apiGet } from './apiClient';

/**
 * STUN público do Google, a reserva.
 *
 * Só STUN: descobrir o endereço externo é o que resolve a maioria das redes
 * domésticas. TURN — retransmitir a mídia — depende de servidor e vem do
 * `/api/ice` quando configurado; aqui, sem ele, alguns pares atrás de NAT
 * difícil não conectam, e a interface já diz isso.
 */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

/*
 * Cache de módulo: a mesma lista serve todas as salas desta aba enquanto vale.
 * Guardar o prazo evita rebuscar a cada entrada de sala — e, com TURN
 * temporário, garante que uma credencial vencida seja trocada a tempo.
 */
let cache: { servers: RTCIceServer[]; expiresAt: number } | null = null;

export async function fetchIceServers(): Promise<RTCIceServer[]> {
  const agora = Date.now();
  if (cache !== null && cache.expiresAt > agora) {
    return cache.servers;
  }

  try {
    const config = await apiGet<IceConfig>('/ice');
    const servers: RTCIceServer[] = config.iceServers.map((server) => ({
      urls: server.urls,
      ...(server.username !== undefined ? { username: server.username } : {}),
      ...(server.credential !== undefined ? { credential: server.credential } : {}),
    }));
    if (servers.length === 0) {
      return DEFAULT_ICE_SERVERS;
    }
    // Piso de 60 s no TTL: protege contra uma configuração que devolva prazo
    // curto demais e faça o cliente rebuscar em loop.
    cache = { servers, expiresAt: agora + Math.max(60, config.ttlSeconds) * 1000 };
    return servers;
  } catch {
    return DEFAULT_ICE_SERVERS;
  }
}
