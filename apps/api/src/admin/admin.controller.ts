import { Body, Controller, Get, Param, Patch, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  LOG_LEVELS,
  type AdminUserRow,
  type AuditLogEntry,
  type DashboardMetrics,
  type LogLevel,
  type Page,
  type SystemLogEntry,
} from '@telecord/shared';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import type { AccessClaims } from '../auth/tokens';
import { badRequest } from '../common/errors';
import { decodeCursor, parseLimit } from '../common/pagination';
import { actorOf, clientOf } from '../rooms/rooms.controller';
import { AdminService } from './admin.service';
import { MetricsService } from './metrics.service';

const STATUSES = ['ACTIVE', 'SUSPENDED', 'BANNED'] as const;
const ROLES = ['USER', 'ADMIN'] as const;

/**
 * Painel de administração.
 *
 * `@Roles('ADMIN')` está na CLASSE, não nos métodos, e isso é o requisito do
 * §5.3 do documento levado a sério: uma rota nova acrescentada aqui embaixo
 * nasce restrita sem ninguém precisar lembrar de anotá-la. Proteger método a
 * método significa que a próxima rota depende da memória de quem a escreveu —
 * e a que ficar de fora não avisa, só fica aberta.
 *
 * O guard global já exige sessão; o decorador acrescenta o papel. As duas
 * verificações acontecem no SERVIDOR. A tela esconder o menu do painel é
 * conveniência, não controle: a rota responde 403 para uma conta comum mesmo
 * que ela chame o endereço direto.
 */
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly metrics: MetricsService,
  ) {}

  @Get('metrics')
  async dashboard(@Query('days') days: string | undefined): Promise<DashboardMetrics> {
    return this.metrics.dashboard(MetricsService.normalizeDays(days));
  }

  @Get('logs')
  async logs(
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('level') level: string | undefined,
    @Query('scope') scope: string | undefined,
    @Query('q') search: string | undefined,
  ): Promise<Page<SystemLogEntry>> {
    return this.admin.logs(decodeCursor(cursor), parseLimit(limit), {
      level: readLevel(level),
      scope: readText(scope, 32),
      search: readText(search, 80),
    });
  }

  @Get('logs/scopes')
  async scopes(): Promise<{ scopes: string[] }> {
    return { scopes: await this.admin.logScopes() };
  }

  @Get('audit')
  async audit(
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('action') action: string | undefined,
  ): Promise<Page<AuditLogEntry>> {
    return this.admin.audit(decodeCursor(cursor), parseLimit(limit), readText(action, 48));
  }

  @Get('users')
  async users(
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('q') search: string | undefined,
  ): Promise<Page<AdminUserRow>> {
    return this.admin.users(decodeCursor(cursor), parseLimit(limit), readText(search, 80));
  }

  @Patch('users/:id')
  async updateUser(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() claims: AccessClaims | undefined,
    @Req() request: Request,
  ): Promise<AdminUserRow> {
    const patch: Parameters<AdminService['updateUser']>[1] = {};

    if (body.role !== undefined) {
      const role = ROLES.find((allowed) => allowed === body.role);
      if (role === undefined) throw badRequest('invalid_request', 'Papel inválido.');
      patch.role = role;
    }
    if (body.status !== undefined) {
      const status = STATUSES.find((allowed) => allowed === body.status);
      if (status === undefined) throw badRequest('invalid_request', 'Situação inválida.');
      patch.status = status;
    }

    return this.admin.updateUser(id, patch, actorOf(claims), clientOf(request));
  }
}

function readLevel(value: string | undefined): LogLevel | null {
  if (value === undefined || value === '') return null;
  return LOG_LEVELS.find((level) => level === value) ?? null;
}

function readText(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}
