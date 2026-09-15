/**
 * Leituras do painel de administração.
 *
 * Todas as rotas daqui respondem 403 para conta comum, decidido no servidor
 * (`@Roles('ADMIN')` na classe do controller). O painel esconder o menu é
 * conveniência de navegação, não controle de acesso — quem digitar o endereço
 * recebe 403 igual.
 */
import type {
  AdminChannelRow,
  AdminRoomRow,
  AdminSessionRow,
  AdminSessionTokenRow,
  AdminSoundRow,
  AdminUserRow,
  AuditLogEntry,
  DashboardMetrics,
  LiveParticipant,
  LiveRoom,
  LogLevel,
  Page,
  RoomTransport,
  SystemLogEntry,
} from '@telecord/shared';
import { apiGet, apiJson, query } from './apiClient';

export async function fetchMetrics(days: number, signal?: AbortSignal): Promise<DashboardMetrics> {
  return apiGet<DashboardMetrics>(`/admin/metrics${query({ days })}`, signal);
}

export interface LogQuery {
  cursor?: string | null;
  level?: LogLevel | null;
  scope?: string | null;
  q?: string | null;
  limit?: number;
}

export async function fetchLogs(
  options: LogQuery = {},
  signal?: AbortSignal,
): Promise<Page<SystemLogEntry>> {
  return apiGet<Page<SystemLogEntry>>(
    `/admin/logs${query({
      cursor: options.cursor,
      level: options.level,
      scope: options.scope,
      q: options.q,
      limit: options.limit ?? 50,
    })}`,
    signal,
  );
}

export async function fetchLogScopes(signal?: AbortSignal): Promise<string[]> {
  const { scopes } = await apiGet<{ scopes: string[] }>('/admin/logs/scopes', signal);
  return scopes;
}

export async function fetchAudit(
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<Page<AuditLogEntry>> {
  return apiGet<Page<AuditLogEntry>>(`/admin/audit${query({ cursor, limit: 50 })}`, signal);
}

export async function fetchUsers(
  options: { cursor?: string | null; q?: string | null } = {},
  signal?: AbortSignal,
): Promise<Page<AdminUserRow>> {
  return apiGet<Page<AdminUserRow>>(
    `/admin/users${query({ cursor: options.cursor, q: options.q, limit: 50 })}`,
    signal,
  );
}

export async function updateUser(
  id: string,
  patch: { role?: 'USER' | 'ADMIN'; status?: 'ACTIVE' | 'SUSPENDED' | 'BANNED' },
): Promise<AdminUserRow> {
  return apiJson<AdminUserRow>(`/admin/users/${encodeURIComponent(id)}`, 'PATCH', patch);
}

// ---------------------------------------------------------------------------
// As demais tabelas
// ---------------------------------------------------------------------------

/** Todas paginam igual: keyset por `cursor`, busca opcional por `q`. */
export interface TableQuery {
  cursor?: string | null;
  q?: string | null;
  limit?: number;
}

function table<T>(path: string, options: TableQuery, signal?: AbortSignal): Promise<Page<T>> {
  return apiGet<Page<T>>(
    `/admin/${path}${query({ cursor: options.cursor, q: options.q, limit: options.limit ?? 50 })}`,
    signal,
  );
}

export const fetchAdminRooms = (o: TableQuery = {}, s?: AbortSignal): Promise<Page<AdminRoomRow>> =>
  table<AdminRoomRow>('rooms', o, s);

export const fetchAdminChannels = (
  o: TableQuery = {},
  s?: AbortSignal,
): Promise<Page<AdminChannelRow>> => table<AdminChannelRow>('channels', o, s);

export const fetchAdminSounds = (
  o: TableQuery = {},
  s?: AbortSignal,
): Promise<Page<AdminSoundRow>> => table<AdminSoundRow>('sounds', o, s);

export const fetchAdminSessions = (
  o: TableQuery = {},
  s?: AbortSignal,
): Promise<Page<AdminSessionRow>> => table<AdminSessionRow>('sessions', o, s);

export const fetchAdminLogins = (
  o: TableQuery = {},
  s?: AbortSignal,
): Promise<Page<AdminSessionTokenRow>> => table<AdminSessionTokenRow>('logins', o, s);

// ---------------------------------------------------------------------------
// Moderação ao vivo
// ---------------------------------------------------------------------------

export async function fetchLiveRooms(signal?: AbortSignal): Promise<LiveRoom[]> {
  return apiGet<LiveRoom[]>('/admin/live', signal);
}

export async function fetchLiveParticipants(
  slug: string,
  transport: RoomTransport,
  signal?: AbortSignal,
): Promise<LiveParticipant[]> {
  return apiGet<LiveParticipant[]>(
    `/admin/live/${encodeURIComponent(slug)}${query({ transport })}`,
    signal,
  );
}

const live = (slug: string, identity: string): string =>
  `/admin/live/${encodeURIComponent(slug)}/${encodeURIComponent(identity)}`;

/**
 * `muted` explícito: o painel pode estar com um estado velho na tela.
 *
 * Em `transport: 'MEDIASOUP'` isto é COOPERATIVO — o SFU não tem como mutar
 * outro peer à força (ver `MediasoupModerationService` no backend); o pedido
 * fica pendente até o cliente da pessoa obedecer no próximo heartbeat.
 */
export async function muteParticipant(
  slug: string,
  identity: string,
  muted: boolean,
  transport: RoomTransport,
): Promise<void> {
  await apiJson<{ ok: true }>(`${live(slug, identity)}/mute`, 'POST', { muted, transport });
}

/** Em `transport: 'MEDIASOUP'` também é cooperativo — ver `muteParticipant`. */
export async function moveParticipant(
  slug: string,
  identity: string,
  destino: string,
  transport: RoomTransport,
): Promise<void> {
  await apiJson<{ ok: true }>(`${live(slug, identity)}/move`, 'POST', { destino, transport });
}

export async function removeParticipant(
  slug: string,
  identity: string,
  transport: RoomTransport,
): Promise<void> {
  await apiJson<{ ok: true }>(`${live(slug, identity)}${query({ transport })}`, 'DELETE', undefined);
}

/** Apaga a sala mediasoup ao vivo inteira — kick em massa. Não existe para LiveKit (ver `admin.controller.ts`). */
export async function deleteLiveRoom(slug: string): Promise<{ removed: number }> {
  return apiJson<{ ok: true; removed: number }>(`/admin/live/${encodeURIComponent(slug)}`, 'DELETE', undefined);
}
