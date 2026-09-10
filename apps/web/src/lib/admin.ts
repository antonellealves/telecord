/**
 * Leituras do painel de administração.
 *
 * Todas as rotas daqui respondem 403 para conta comum, decidido no servidor
 * (`@Roles('ADMIN')` na classe do controller). O painel esconder o menu é
 * conveniência de navegação, não controle de acesso — quem digitar o endereço
 * recebe 403 igual.
 */
import type {
  AdminUserRow,
  AuditLogEntry,
  DashboardMetrics,
  LogLevel,
  Page,
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
