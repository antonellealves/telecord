/**
 * Canais: agrupadores de salas transitáveis.
 *
 * Um canal não é um lugar que se "entra" — não tem conexão de voz própria.
 * Cada sala listada dentro dele continua sendo uma sala LiveKit normal;
 * "transitar" entre elas é sair da conexão atual e entrar na nova, e é a
 * `ChannelPage` que faz esse salto de um clique, sem passar pela tela
 * inicial.
 */
import type {
  ChannelDetail,
  ChannelMemberRole,
  ChannelSummary,
  Page,
  RoomVisibility,
} from '@telecord/shared';
import { apiGet, apiJson, query } from './apiClient';

export async function fetchChannelDirectory(
  cursor?: string,
  signal?: AbortSignal,
): Promise<Page<ChannelSummary>> {
  return apiGet<Page<ChannelSummary>>(`/channels/directory${query({ cursor, limit: 60 })}`, signal);
}

export async function fetchMyChannels(signal?: AbortSignal): Promise<ChannelSummary[]> {
  return apiGet<ChannelSummary[]>('/channels/mine', signal);
}

export async function fetchChannel(slug: string, signal?: AbortSignal): Promise<ChannelDetail> {
  return apiGet<ChannelDetail>(`/channels/${encodeURIComponent(slug)}`, signal);
}

export async function createChannel(input: {
  slug: string;
  name: string;
  description?: string | null;
  emoji?: string | null;
  visibility?: RoomVisibility;
}): Promise<ChannelDetail> {
  return apiJson<ChannelDetail>('/channels', 'POST', input);
}

export async function updateChannel(
  slug: string,
  patch: {
    name?: string;
    description?: string | null;
    emoji?: string | null;
    visibility?: RoomVisibility;
  },
): Promise<ChannelDetail> {
  return apiJson<ChannelDetail>(`/channels/${encodeURIComponent(slug)}`, 'PATCH', patch);
}

export async function deleteChannel(slug: string): Promise<void> {
  await apiJson<void>(`/channels/${encodeURIComponent(slug)}`, 'DELETE');
}

export async function setChannelMemberRole(
  slug: string,
  userId: string,
  role: ChannelMemberRole,
): Promise<ChannelDetail> {
  return apiJson<ChannelDetail>(
    `/channels/${encodeURIComponent(slug)}/members/${encodeURIComponent(userId)}`,
    'PUT',
    { role },
  );
}

export async function removeChannelMember(slug: string, userId: string): Promise<ChannelDetail> {
  return apiJson<ChannelDetail>(
    `/channels/${encodeURIComponent(slug)}/members/${encodeURIComponent(userId)}`,
    'DELETE',
  );
}

/** Vincula uma sala JÁ EXISTENTE ao canal. Não cria sala — use `createRoom` antes. */
export async function addRoomToChannel(
  channelSlug: string,
  roomSlug: string,
): Promise<ChannelDetail> {
  return apiJson<ChannelDetail>(
    `/channels/${encodeURIComponent(channelSlug)}/rooms/${encodeURIComponent(roomSlug)}`,
    'PUT',
  );
}

/** Solta a sala do canal. A sala CONTINUA existindo, só some da lista do canal. */
export async function removeRoomFromChannel(
  channelSlug: string,
  roomSlug: string,
): Promise<ChannelDetail> {
  return apiJson<ChannelDetail>(
    `/channels/${encodeURIComponent(channelSlug)}/rooms/${encodeURIComponent(roomSlug)}`,
    'DELETE',
  );
}

/** Substitui a ordem inteira das salas do canal. `order` precisa ser exatamente o conjunto atual. */
export async function reorderChannelRooms(
  channelSlug: string,
  order: string[],
): Promise<ChannelDetail> {
  return apiJson<ChannelDetail>(`/channels/${encodeURIComponent(channelSlug)}/rooms`, 'PUT', {
    order,
  });
}
