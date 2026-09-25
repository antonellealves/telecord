/**
 * Presença e arrumação de quadros, vistas do navegador.
 */
import type { TileLayout } from '@telecord/shared';
import { apiJson } from './apiClient';

const base = (slug: string): string => `/peers/${encodeURIComponent(slug)}`;

export async function peerLeave(slug: string, peerId: string): Promise<void> {
  await apiJson<{ ok: true }>(`${base(slug)}/leave`, 'POST', { peerId });
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
