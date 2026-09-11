import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma';
import type {
  AdminUserRow,
  AuditLogEntry,
  LogLevel,
  Page,
  SystemLogEntry,
} from '@telecord/shared';
import { badRequest, forbidden, notFound } from '../common/errors';
import { buildPage, encodeCursor, keysetBefore, type Keyset } from '../common/pagination';
import { LogService, type LogClient } from '../logging/log.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Actor } from '../rooms/rooms.service';

export interface LogFilters {
  level: LogLevel | null;
  scope: string | null;
  search: string | null;
}

/**
 * Leituras e ações do painel de administração.
 *
 * ## O que um administrador NÃO consegue fazer aqui
 *
 * Duas coisas, e a ausência é deliberada:
 *
 * - **Ler senha.** Nenhuma consulta deste arquivo seleciona `passwordHash`, e
 *   `toRow` monta a linha campo a campo em vez de espalhar o registro do
 *   banco. Não é só que o hash seja inútil sozinho: o caminho não existe.
 * - **Entrar como outra pessoa.** Não há emissão de sessão em nome de
 *   terceiro. Suporte se faz com o log, que registra o que aconteceu, e não
 *   assumindo a identidade de quem pediu ajuda.
 *
 * ## O nome de quem aparece no log
 *
 * As tabelas de log guardam só o id do usuário. O nome é resolvido em UMA
 * consulta por página — os ids distintos da página, de uma vez — e não uma por
 * linha. Numa página de 50 linhas de log a diferença é entre uma ida ao banco
 * e cinquenta.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly log: LogService,
  ) {}

  // -------------------------------------------------------------------------
  // Log técnico
  // -------------------------------------------------------------------------

  async logs(
    cursor: Keyset | null,
    limit: number,
    filters: LogFilters,
  ): Promise<Page<SystemLogEntry>> {
    const where: Prisma.SystemLogWhereInput = {
      ...(filters.level === null ? {} : { level: filters.level }),
      ...(filters.scope === null ? {} : { scope: filters.scope }),
      ...(filters.search === null
        ? {}
        : {
            OR: [
              { message: { contains: filters.search } },
              { event: { contains: filters.search } },
              { roomSlug: { contains: filters.search } },
            ],
          }),
      ...(keysetBefore(cursor, 'createdAt') as Prisma.SystemLogWhereInput),
    };

    const rows = await this.prisma.systemLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const names = await this.namesFor(rows.map((row) => row.userId));
    return buildPage(
      rows,
      limit,
      (row): SystemLogEntry => ({
        id: row.id,
        level: row.level,
        scope: row.scope,
        event: row.event,
        message: row.message,
        userId: row.userId,
        userLabel: row.userId === null ? null : (names.get(row.userId) ?? null),
        roomSlug: row.roomSlug,
        ip: row.ip,
        context: (row.context as Record<string, unknown> | null) ?? null,
        createdAt: row.createdAt.toISOString(),
      }),
      (row) => encodeCursor(row.createdAt, row.id),
    );
  }

  /** Escopos existentes, para o filtro do painel não ser um campo de texto. */
  async logScopes(): Promise<string[]> {
    const rows = await this.prisma.systemLog.groupBy({ by: ['scope'], _count: { _all: true } });
    return rows.map((row) => row.scope).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }

  // -------------------------------------------------------------------------
  // Auditoria
  // -------------------------------------------------------------------------

  async audit(
    cursor: Keyset | null,
    limit: number,
    action: string | null,
  ): Promise<Page<AuditLogEntry>> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        ...(action === null ? {} : { action }),
        ...(keysetBefore(cursor, 'createdAt') as Prisma.AuditLogWhereInput),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    return buildPage(
      rows,
      limit,
      (row): AuditLogEntry => ({
        id: row.id,
        actorId: row.actorId,
        actorLabel: row.actorLabel,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        summary: row.summary,
        before: (row.before as Record<string, unknown> | null) ?? null,
        after: (row.after as Record<string, unknown> | null) ?? null,
        ip: row.ip,
        createdAt: row.createdAt.toISOString(),
      }),
      (row) => encodeCursor(row.createdAt, row.id),
    );
  }

  // -------------------------------------------------------------------------
  // Contas
  // -------------------------------------------------------------------------

  async users(
    cursor: Keyset | null,
    limit: number,
    search: string | null,
  ): Promise<Page<AdminUserRow>> {
    const rows = await this.prisma.user.findMany({
      where: {
        deletedAt: null,
        ...(search === null
          ? {}
          : {
              OR: [
                { email: { contains: search } },
                { displayName: { contains: search } },
                { username: { contains: search } },
              ],
            }),
        ...(keysetBefore(cursor, 'createdAt') as Prisma.UserWhereInput),
      },
      // Campo a campo: é o que garante que `passwordHash` não saia daqui nem
      // por descuido de quem mexer neste arquivo depois.
      select: {
        id: true,
        email: true,
        displayName: true,
        username: true,
        role: true,
        status: true,
        emailVerifiedAt: true,
        createdAt: true,
        lastSeenAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    return buildPage(
      rows,
      limit,
      (row): AdminUserRow => ({
        id: row.id,
        email: row.email,
        displayName: row.displayName,
        username: row.username,
        role: row.role,
        status: row.status,
        emailVerified: row.emailVerifiedAt !== null,
        createdAt: row.createdAt.toISOString(),
        lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      }),
      (row) => encodeCursor(row.createdAt, row.id),
    );
  }

  /**
   * Muda papel e situação de uma conta.
   *
   * Bloqueia mexer na própria conta. Não é paternalismo: o único administrador
   * do sistema que se rebaixasse por engano deixaria a instalação sem ninguém
   * capaz de desfazer, e a saída seria editar o banco à mão.
   *
   * Suspender derruba as sessões vivas na hora. Sem isso, a pessoa suspensa
   * continuaria usando o access token que já tem até ele vencer — e "suspenso"
   * que só vale daqui a quinze minutos não é suspensão.
   */
  async updateUser(
    id: string,
    patch: { role?: 'USER' | 'ADMIN'; status?: 'ACTIVE' | 'SUSPENDED' | 'BANNED' },
    actor: Actor,
    client: LogClient,
  ): Promise<AdminUserRow> {
    if (id === actor.id) {
      throw forbidden('self_change', 'Mexer na própria conta por aqui, não.');
    }
    if (patch.role === undefined && patch.status === undefined) {
      throw badRequest('invalid_request', 'Nada para mudar.');
    }

    const before = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, displayName: true, role: true, status: true },
    });
    if (before === null) {
      throw notFound('user_not_found', 'Conta não encontrada.');
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        ...(patch.role === undefined ? {} : { role: patch.role }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
      },
      select: {
        id: true,
        email: true,
        displayName: true,
        username: true,
        role: true,
        status: true,
        emailVerifiedAt: true,
        createdAt: true,
        lastSeenAt: true,
      },
    });

    if (patch.status !== undefined && patch.status !== 'ACTIVE') {
      await this.prisma.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await this.log.audit({
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: 'user.update',
      targetType: 'user',
      targetId: id,
      summary: `alterou a conta de ${before.displayName}`,
      before: { role: before.role, status: before.status },
      after: { role: updated.role, status: updated.status },
      client,
    });
    await this.log.record({
      level: 'WARN',
      scope: 'admin',
      event: 'user.update',
      message: `conta ${before.displayName} alterada por ${actor.displayName}`,
      userId: actor.id,
      context: { role: updated.role, status: updated.status },
      client,
    });

    return {
      id: updated.id,
      email: updated.email,
      displayName: updated.displayName,
      username: updated.username,
      role: updated.role,
      status: updated.status,
      emailVerified: updated.emailVerifiedAt !== null,
      createdAt: updated.createdAt.toISOString(),
      lastSeenAt: updated.lastSeenAt?.toISOString() ?? null,
    };
  }

  // -------------------------------------------------------------------------

  private async namesFor(ids: (string | null)[]): Promise<Map<string, string>> {
    const distinct = [...new Set(ids.filter((id): id is string => id !== null))];
    if (distinct.length === 0) return new Map();

    const users = await this.prisma.user.findMany({
      where: { id: { in: distinct } },
      select: { id: true, displayName: true },
    });
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
