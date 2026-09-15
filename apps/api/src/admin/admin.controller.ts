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
import { MediasoupModerationService } from './mediasoup-moderation.service';
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
    private readonly mediasoupModeration: MediasoupModerationService,
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
  // Duas fontes, sem fonte central comum: LiveKit tem `RoomServiceClient`
  // (`ModerationService`), mediasoup não tem e é agregado da presença
  // (`MediasoupModerationService` — ver a docstring de lá para o porquê de
  // mutar/mover serem cooperativos nesse transporte). `GET /admin/live`
  // mescla as duas; as rotas por sala/participante recebem `?transport=` para
  // saber qual das duas usar (default `LIVEKIT`, o comportamento de sempre).
  // Todas passam por auditoria.
  // -------------------------------------------------------------------------

  @Get('live')
  async live(): Promise<LiveRoom[]> {
    const [livekit, mediasoup] = await Promise.all([
      this.moderation.liveRooms(),
      this.mediasoupModeration.liveRooms(),
    ]);
    return [...livekit, ...mediasoup].sort(
      (a, b) => b.participants - a.participants || a.slug.localeCompare(b.slug),
    );
  }

  @Get('live/:slug')
  async liveRoom(
    @Param('slug') slug: string,
    @Query('transport') transport: string | undefined,
  ): Promise<LiveParticipant[]> {
    return isMediasoup(transport)
      ? this.mediasoupModeration.liveParticipants(slug)
      : this.moderation.liveParticipants(slug);
  }

  /**
   * Token de curta duração para o painel "Ao vivo" abrir o canal Socket.IO
   * de presença direto no mediasoup-sfu — mesmo mecanismo do peer normal
   * (`MediasoupService.clientConfig`), mas sem `roomSlug` fixo: o admin troca
   * de sala no dropdown sem pedir token novo (ver `signAdminPresenceToken`).
   * Só quem já passou pelo guard deste controller chega aqui.
   */
  @Get('live/presence-token')
  async livePresenceToken(@CurrentUser() claims: AccessClaims | undefined): Promise<{ token: string }> {
    const token = await this.mediasoupModeration.issueAdminPresenceToken(actorOf(claims));
    return { token };
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
    const actor = actorOf(claims);
    const client = clientOf(request);
    if (isMediasoup(body.transport)) {
      await this.mediasoupModeration.muteParticipant(slug, identity, body.muted, actor, client);
    } else {
      await this.moderation.muteParticipant(slug, identity, body.muted, actor, client);
    }
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
    const actor = actorOf(claims);
    const client = clientOf(request);
    if (isMediasoup(body.transport)) {
      await this.mediasoupModeration.moveParticipant(slug, identity, destino, actor, client);
    } else {
      await this.moderation.moveParticipant(slug, identity, destino, actor, client);
    }
    return { ok: true };
  }

  @Delete('live/:slug/:identity')
  async kick(
    @Param('slug') slug: string,
    @Param('identity') identity: string,
    @Query('transport') transport: string | undefined,
    @CurrentUser() claims: AccessClaims | undefined,
    @Req() request: Request,
  ): Promise<{ ok: true }> {
    const actor = actorOf(claims);
    const client = clientOf(request);
    if (isMediasoup(transport)) {
      await this.mediasoupModeration.removeParticipant(slug, identity, actor, client);
    } else {
      await this.moderation.removeParticipant(slug, identity, actor, client);
    }
    return { ok: true };
  }

  /**
   * Apaga a sala VIVA inteira — kick em massa. Só existe para mediasoup: no
   * LiveKit o equivalente já é possível hoje mesmo sem esta rota, chamando
   * `DELETE .../identity` para cada participante listado (o painel não tinha
   * um atalho porque ninguém pediu — a sala LiveKit também não expõe
   * "deletar sala ao vivo" na SDK sem remover pessoa por pessoa).
   */
  @Delete('live/:slug')
  async kickRoom(
    @Param('slug') slug: string,
    @CurrentUser() claims: AccessClaims | undefined,
    @Req() request: Request,
  ): Promise<{ ok: true; removed: number }> {
    const removed = await this.mediasoupModeration.removeRoom(slug, actorOf(claims), clientOf(request));
    return { ok: true, removed };
  }
}

function isMediasoup(value: unknown): boolean {
  return value === 'MEDIASOUP' || value === 'mediasoup';
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
