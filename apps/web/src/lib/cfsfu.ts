/**
 * Proxy do Cloudflare Realtime SFU, visto do navegador.
 *
 * O cliente nunca fala com `rtc.live.cloudflare.com` direto — o `appToken` vive
 * só no backend. Estas funções batem no proxy `/api/cfsfu/*`, que assina a
 * chamada à Cloudflare depois de conferir que quem pede está na sala. Toda
 * chamada carrega `roomSlug` + `peerId` para essa portaria.
 */
import type {
  CfCloseBody,
  CfRenegotiateBody,
  CfSessionResult,
  CfSfuClientConfig,
  CfSimpleResult,
  CfTracksBody,
  CfTracksResult,
} from '@telecord/shared';
import { apiGet, apiJson } from './apiClient';

const sessionPath = (sessionId: string): string =>
  `/cfsfu/sessions/${encodeURIComponent(sessionId)}`;

/** Config pública: STUN da Cloudflare, se está ligado e a cota do mês. */
export function fetchCfSfuConfig(): Promise<CfSfuClientConfig> {
  return apiGet<CfSfuClientConfig>('/cfsfu/config');
}

export function cfCreateSession(roomSlug: string, peerId: string): Promise<CfSessionResult> {
  return apiJson<CfSessionResult>('/cfsfu/sessions', 'POST', { roomSlug, peerId });
}

export function cfNewTracks(
  roomSlug: string,
  peerId: string,
  sessionId: string,
  body: CfTracksBody,
): Promise<CfTracksResult> {
  return apiJson<CfTracksResult>(`${sessionPath(sessionId)}/tracks`, 'POST', {
    roomSlug,
    peerId,
    ...body,
  });
}

export function cfRenegotiate(
  roomSlug: string,
  peerId: string,
  sessionId: string,
  body: CfRenegotiateBody,
): Promise<CfSimpleResult> {
  return apiJson<CfSimpleResult>(`${sessionPath(sessionId)}/renegotiate`, 'PUT', {
    roomSlug,
    peerId,
    ...body,
  });
}

export function cfCloseTracks(
  roomSlug: string,
  peerId: string,
  sessionId: string,
  body: CfCloseBody,
): Promise<CfTracksResult> {
  return apiJson<CfTracksResult>(`${sessionPath(sessionId)}/tracks/close`, 'PUT', {
    roomSlug,
    peerId,
    ...body,
  });
}

/** Reporta o egress consumido (bytes recebidos) para a contagem de cota. */
export async function cfReportUsage(
  roomSlug: string,
  peerId: string,
  bytes: number,
): Promise<void> {
  await apiJson<{ ok: true }>('/cfsfu/usage/report', 'POST', { roomSlug, peerId, bytes });
}
