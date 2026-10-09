/**
 * O que o navegador pede a `apps/api` sobre o transporte mediasoup.
 *
 * Uma chamada importa de verdade: `fetchMediasoupConfig`, a ENTRADA na sala.
 * Ela devolve o token com que o navegador abre, direto no SFU, o canal de
 * presença e o canal de mídia (`signalStream.ts`) — e daí em diante criar
 * transporte, publicar e assinar não passam mais por aqui.
 *
 * As funções `ms*` abaixo são o caminho ANTIGO dessas mesmas operações: cada
 * uma é uma requisição ao proxy `/api/mediasoup/*`, que confere a
 * participação na sala e repassa ao SFU com o segredo interno. Continuam
 * existindo para quando o canal de mídia não abre — ver
 * `MediasoupConnection`.
 */
import type {
  MediasoupClientConfig,
  MediasoupConnectTransportBody,
  MediasoupConsumeBody,
  MediasoupConsumeResult,
  MediasoupCreateTransportBody,
  MediasoupProduceBody,
  MediasoupProduceResult,
  MediasoupTransportInfo,
} from '@telecord/shared';
import { apiGet, apiJson, query } from './apiClient';

const roomPath = (roomSlug: string): string => `/mediasoup/rooms/${encodeURIComponent(roomSlug)}`;

/**
 * A entrada: se o transporte está ligado, as RTP capabilities dos Routers,
 * o token de curta duração que abre os canais do mediasoup-sfu e, quando há
 * mais de um nó, qual deles é o desta sala. `peerId`/`displayName` vão na
 * query porque é aqui — e não mais num heartbeat HTTP separado — que a
 * presença inicial é registrada.
 */
export function fetchMediasoupConfig(
  roomSlug: string,
  peerId: string,
  displayName: string,
): Promise<MediasoupClientConfig> {
  return apiGet<MediasoupClientConfig>(`${roomPath(roomSlug)}/config${query({ peerId, displayName })}`);
}

/** Token de curta duração para o painel admin abrir o socket de presença sem `roomSlug` fixo. */
export function fetchAdminPresenceToken(): Promise<{ token: string }> {
  return apiGet<{ token: string }>('/admin/live/presence-token');
}

export function msCreateTransport(
  roomSlug: string,
  body: MediasoupCreateTransportBody,
): Promise<MediasoupTransportInfo> {
  return apiJson<MediasoupTransportInfo>(`${roomPath(roomSlug)}/transports`, 'POST', body);
}

export function msConnectTransport(
  roomSlug: string,
  transportId: string,
  body: MediasoupConnectTransportBody,
): Promise<{ ok: true }> {
  return apiJson<{ ok: true }>(
    `${roomPath(roomSlug)}/transports/${encodeURIComponent(transportId)}/connect`,
    'POST',
    body,
  );
}

export function msProduce(
  roomSlug: string,
  transportId: string,
  body: MediasoupProduceBody,
): Promise<MediasoupProduceResult> {
  return apiJson<MediasoupProduceResult>(
    `${roomPath(roomSlug)}/transports/${encodeURIComponent(transportId)}/produce`,
    'POST',
    body,
  );
}

export function msConsume(
  roomSlug: string,
  transportId: string,
  body: MediasoupConsumeBody,
): Promise<MediasoupConsumeResult> {
  return apiJson<MediasoupConsumeResult>(
    `${roomPath(roomSlug)}/transports/${encodeURIComponent(transportId)}/consume`,
    'POST',
    body,
  );
}

export function msResumeConsumer(
  roomSlug: string,
  consumerId: string,
  peerId: string,
): Promise<{ ok: true }> {
  return apiJson<{ ok: true }>(
    `${roomPath(roomSlug)}/consumers/${encodeURIComponent(consumerId)}/resume`,
    'POST',
    { peerId },
  );
}

export function msLeave(roomSlug: string, peerId: string): Promise<{ ok: true }> {
  return apiJson<{ ok: true }>(`${roomPath(roomSlug)}/leave`, 'POST', { peerId });
}
