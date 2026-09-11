/**
 * Sinalização do modo P2P, vista do navegador.
 *
 * Tudo POST, inclusive as leituras: `inbox` lê e apaga na mesma chamada, então
 * não é idempotente e não pode ser GET — um proxy que repita a requisição
 * comeria sinal de alguém.
 */
import type { PeerInbox, PeerRoster, PeerSignalKind, TileLayout } from '@telecord/shared';
import { apiJson } from './apiClient';

const base = (slug: string): string => `/peers/${encodeURIComponent(slug)}`;

export async function peerHeartbeat(
  slug: string,
  peerId: string,
  displayName: string,
): Promise<PeerRoster> {
  return apiJson<PeerRoster>(`${base(slug)}/heartbeat`, 'POST', { peerId, displayName });
}

export async function peerLeave(slug: string, peerId: string): Promise<void> {
  await apiJson<{ ok: true }>(`${base(slug)}/leave`, 'POST', { peerId });
}

export async function peerSignal(
  slug: string,
  fromPeer: string,
  toPeer: string,
  kind: PeerSignalKind,
  payload: string,
): Promise<void> {
  await apiJson<{ ok: true }>(`${base(slug)}/signal`, 'POST', {
    fromPeer,
    toPeer,
    kind,
    payload,
  });
}

export async function peerInbox(slug: string, peerId: string): Promise<PeerInbox> {
  return apiJson<PeerInbox>(`${base(slug)}/inbox`, 'POST', { peerId });
}

export async function fetchLayout(slug: string, peerId: string): Promise<TileLayout> {
  const { tiles } = await apiJson<{ tiles: TileLayout }>(`${base(slug)}/layout`, 'POST', {
    peerId,
  });
  return tiles;
}

export async function saveLayout(
  slug: string,
  peerId: string,
  tiles: TileLayout,
): Promise<void> {
  await apiJson<{ ok: true }>(`${base(slug)}/layout/save`, 'POST', { peerId, tiles });
}
