/**
 * Proxy do processo mediasoup-sfu, visto do navegador.
 *
 * O cliente nunca fala com o processo na VM direto — o segredo interno vive só
 * no backend. Estas funções batem no proxy `/api/mediasoup/*`, que confere a
 * participação na sala antes de repassar. Mesmo desenho de `cfsfu.ts`.
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
 * Config pública: se está ligado, as RTP capabilities do Router da sala, e o
 * token de curta duração para abrir o canal Socket.IO de presença direto no
 * mediasoup-sfu. `peerId`/`displayName` vão na query porque é aqui — e não
 * mais num heartbeat HTTP separado — que a presença inicial é registrada.
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
