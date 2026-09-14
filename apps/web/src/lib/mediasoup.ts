/**
 * Proxy do processo mediasoup-sfu, visto do navegador.
 *
 * O cliente nunca fala com o processo na VM direto — o segredo interno vive só
 * no backend. Estas funções batem no proxy `/api/mediasoup/*`, que confere a
 * participação na sala antes de repassar. Mesmo desenho de `cfsfu.ts`.
 */
import type {
  MediasoupBroadcastPollResult,
  MediasoupBroadcastSendBody,
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

/** Config pública: se está ligado e as RTP capabilities do Router da sala. */
export function fetchMediasoupConfig(roomSlug: string): Promise<MediasoupClientConfig> {
  return apiGet<MediasoupClientConfig>(`${roomPath(roomSlug)}/config`);
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

/** Chat/soundboard por polling — ver `RoomBroadcastMessage` no schema da API. */
export function msSendBroadcast(
  roomSlug: string,
  body: MediasoupBroadcastSendBody,
): Promise<{ ok: true }> {
  return apiJson<{ ok: true }>(`${roomPath(roomSlug)}/broadcast`, 'POST', body);
}

export function msPollBroadcast(
  roomSlug: string,
  peerId: string,
  since: string | null,
): Promise<MediasoupBroadcastPollResult> {
  return apiGet<MediasoupBroadcastPollResult>(
    `${roomPath(roomSlug)}/broadcast${query({ peerId, since })}`,
  );
}
