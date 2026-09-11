import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  LOG_LEVELS,
  type AdminChannelRow,
  type AdminRoomRow,
  type AdminSessionRow,
  type AdminSessionTokenRow,
  type AdminSoundRow,
  type AdminUserRow,
  type AuditLogEntry,
  type DashboardMetrics,
  type LiveParticipant,
  type LiveRoom,
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
import { ModerationService } from './moderation.service';

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
    private readonly moderation: ModerationService,
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
  // -------------------------------------------------------------------------
  // As demais tabelas
  // -------------------------------------------------------------------------

  @Get('rooms')
  async rooms(
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('q') search: string | undefined,
  ): Promise<Page<AdminRoomRow>> {
    return this.admin.rooms(decodeCursor(cursor), parseLimit(limit), readText(search, 80));
  }

  @Get('channels')
  async channels(
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('q') search: string | undefined,
  ): Promise<Page<AdminChannelRow>> {
    return this.admin.channels(decodeCursor(cursor), parseLimit(limit), readText(search, 80));
  }

  @Get('sounds')
  async sounds(
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('q') search: string | undefined,
  ): Promise<Page<AdminSoundRow>> {
    return this.admin.sounds(decodeCursor(cursor), parseLimit(limit), readText(search, 80));
  }

  @Get('sessions')
  async sessions(
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('q') search: string | undefined,
  ): Promise<Page<AdminSessionRow>> {
    return this.admin.mediaSessions(decodeCursor(cursor), parseLimit(limit), readText(search, 80));
  }

  @Get('logins')
  async logins(
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<Page<AdminSessionTokenRow>> {
    return this.admin.loginSessions(decodeCursor(cursor), parseLimit(limit));
  }

  // -------------------------------------------------------------------------
  // Moderação da sala VIVA
  //
  // Estas rotas falam com o SFU, não com o banco: quem está conectado agora só
  // o LiveKit sabe. Todas passam por auditoria — ver `ModerationService`.
  // -------------------------------------------------------------------------

  @Get('live')
  async live(): Promise<LiveRoom[]> {
    return this.moderation.liveRooms();
  }

  @Get('live/:slug')
  async liveRoom(@Param('slug') slug: string): Promise<LiveParticipant[]> {
    return this.moderation.liveParticipants(slug);
  }

  @Post('live/:slug/:identity/mute')
  async mute(
    @Param('slug') slug: string,
    @Param('identity') identity: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() claims: AccessClaims | undefined,
    @Req() request: Request,
  ): Promise<{ ok: true }> {
    // `muted` explícito, e não alternância: o painel pode estar vendo um estado
    // velho, e "alternar" a partir dele faria o botão mutar quem já está mudo.
    if (typeof body.muted !== 'boolean') {
      throw badRequest('invalid_request', 'Informe `muted` como true ou false.');
    }
    await this.moderation.muteParticipant(
      slug,
      identity,
      body.muted,
      actorOf(claims),
      clientOf(request),
    );
    return { ok: true };
  }

  @Post('live/:slug/:identity/move')
  async move(
    @Param('slug') slug: string,
    @Param('identity') identity: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() claims: AccessClaims | undefined,
    @Req() request: Request,
  ): Promise<{ ok: true }> {
    const destino = typeof body.destino === 'string' ? body.destino.trim().slice(0, 64) : '';
    if (destino === '') {
      throw badRequest('invalid_request', 'Informe a sala de destino.');
    }
    await this.moderation.moveParticipant(
      slug,
      identity,
      destino,
      actorOf(claims),
      clientOf(request),
    );
    return { ok: true };
  }

  @Delete('live/:slug/:identity')
  async kick(
    @Param('slug') slug: string,
    @Param('identity') identity: string,
    @CurrentUser() claims: AccessClaims | undefined,
    @Req() request: Request,
  ): Promise<{ ok: true }> {
    await this.moderation.removeParticipant(slug, identity, actorOf(claims), clientOf(request));
    return { ok: true };
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
