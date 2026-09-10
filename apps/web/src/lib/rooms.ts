/**
 * Salas persistidas.
 *
 * Cuidado com o nome: `GET /api/rooms` (sem sufixo) é outra coisa — é a função
 * serverless que lista as salas VIVAS no LiveKit, usada por `useActiveRooms`,
 * e que funciona com este serviço inteiro fora do ar. O que está aqui embaixo
 * é o metadado das salas nomeadas, e depende do banco.
 *
 * A tela inicial junta os dois: a lista viva diz quem está online agora, o
 * diretório diz como a sala se chama.
 */
import type { Page, RoomDetail, RoomMemberRole, RoomSummary, RoomVisibility } from '@telecord/shared';
import { apiGet, apiJson, query } from './apiClient';

export async function fetchDirectory(cursor?: string, signal?: AbortSignal): Promise<Page<RoomSummary>> {
  return apiGet<Page<RoomSummary>>(`/rooms/directory${query({ cursor, limit: 60 })}`, signal);
}

export async function fetchMyRooms(signal?: AbortSignal): Promise<RoomSummary[]> {
  return apiGet<RoomSummary[]>('/rooms/mine', signal);
}

export async function fetchRoom(slug: string, signal?: AbortSignal): Promise<RoomDetail> {
  return apiGet<RoomDetail>(`/rooms/${encodeURIComponent(slug)}`, signal);
}

export async function createRoom(input: {
  slug: string;
  name: string;
  description?: string | null;
  emoji?: string | null;
  visibility?: RoomVisibility;
}): Promise<RoomDetail> {
  return apiJson<RoomDetail>('/rooms', 'POST', input);
}

export async function updateRoom(
  slug: string,
  patch: {
    name?: string;
    description?: string | null;
    emoji?: string | null;
    visibility?: RoomVisibility;
  },
): Promise<RoomDetail> {
  return apiJson<RoomDetail>(`/rooms/${encodeURIComponent(slug)}`, 'PATCH', patch);
}

export async function deleteRoom(slug: string): Promise<void> {
  await apiJson<void>(`/rooms/${encodeURIComponent(slug)}`, 'DELETE');
}

export async function setMemberRole(
  slug: string,
  userId: string,
  role: RoomMemberRole,
): Promise<RoomDetail> {
  return apiJson<RoomDetail>(
    `/rooms/${encodeURIComponent(slug)}/members/${encodeURIComponent(userId)}`,
    'PUT',
    { role },
  );
}

export async function removeMember(slug: string, userId: string): Promise<RoomDetail> {
  return apiJson<RoomDetail>(
    `/rooms/${encodeURIComponent(slug)}/members/${encodeURIComponent(userId)}`,
    'DELETE',
  );
}
