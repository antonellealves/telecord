import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  validateChannelDescription,
  validateChannelName,
  validateRoomId,
  type ChannelDetail,
  type ChannelMemberRole,
  type ChannelSummary,
  type Page,
  type RoomVisibility,
} from '@telecord/shared';
import { CurrentUser, OptionalAuth, Public } from '../auth/auth.decorators';
import type { AccessClaims } from '../auth/tokens';
import { badRequest } from '../common/errors';
import { decodeCursor, parseLimit } from '../common/pagination';
import { actorOf, clientOf } from '../rooms/rooms.controller';
import { ChannelsService } from './channels.service';

const VISIBILITIES: readonly RoomVisibility[] = ['PUBLIC', 'UNLISTED'];
const MEMBER_ROLES: readonly ChannelMemberRole[] = ['OWNER', 'MOD', 'MEMBER'];

/**
 * Canais: agrupadores de salas transitáveis.
 *
 * ## Onde estas rotas moram
 *
 * Tudo sob `/api/channels` cai neste controller e não colide com nenhuma
 * função serverless própria — diferente de `rooms`, não existe
 * `api/channels.ts` esperando o caminho exato. A captura `api/[...nest].ts`
 * cobre `/api/channels` inteiro sozinha.
 *
 * ## Autorização
 *
 * Mesmo desenho de `RoomsController`: o guard global cuida da sessão, e quem
 * decide o papel DENTRO do canal é `ChannelsService.assertCanManage`, chamado
 * de um lugar só.
 */
@Controller('channels')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Public()
  @Get('directory')
  async directory(
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<Page<ChannelSummary>> {
    return this.channels.directory(decodeCursor(cursor), parseLimit(limit));
  }

  @Get('mine')
  async mine(@CurrentUser() claims: AccessClaims | undefined): Promise<ChannelSummary[]> {
    return this.channels.mine(actorOf(claims).id);
  }

  /*
   * Opcional, e não pública: pelo mesmo motivo de `RoomsController.detail` —
   * a resposta muda com quem pergunta (`myRole`), sem exigir conta para ver o
   * canal e navegar as salas dele.
   */
  @OptionalAuth()
  @Get(':slug')
  async detail(
    @Param('slug') slug: string,
    @CurrentUser() claims: AccessClaims | undefined,
  ): Promise<ChannelDetail> {
    checkSlug(slug);
    return this.channels.detail(slug, claims?.sub ?? null);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post()
  async create(
    @Body() body: Record<string, unknown>,
    @CurrentUser() claims: AccessClaims | undefined,
    @Req() request: Request,
  ): Promise<ChannelDetail> {
    const slug = readString(body.slug, 'slug');
    const name = readString(body.name, 'name');
    checkSlug(slug);
    check(validateChannelName(name));

    const description = readOptional(body.description);
    if (description !== null) check(validateChannelDescription(description));

    return this.channels.create(
      {
        slug,
        name,
        description,
        emoji: readEmoji(body.emoji),
        visibility: readVisibility(body.visibility) ?? 'PUBLIC',
      },
      actorOf(claims),
      clientOf(request),
    );
  }

  @Patch(':slug')
  async update(
    @Param('slug') slug: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() claims: AccessClaims | undefined,
    @Req() request: Request,
  ): Promise<ChannelDetail> {
    checkSlug(slug);

    const patch: Parameters<ChannelsService['update']>[1] = {};
    if (body.name !== undefined) {
      const name = readString(body.name, 'name');
      check(validateChannelName(name));
      patch.name = name;
    }
    if (body.description !== undefined) {
      const description = readOptional(body.description);
      if (description !== null) check(validateChannelDescription(description));
      patch.description = description;
    }
    if (body.emoji !== undefined) patch.emoji = readEmoji(body.emoji);
    if (body.visibility !== undefined) {
      const visibility = readVisibility(body.visibility);
      if (visibility === null) throw badRequest('invalid_request', 'Visibilidade inválida.');
      patch.visibility = visibility;
    }

    return this.channels.update(slug, patch, actorOf(claims), clientOf(request));
  }

  @Delete(':slug')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('slug') slug: string,
    @CurrentUser() claims: AccessClaims | undefined,
    @Req() request: Request,
  ): Promise<void> {
    checkSlug(slug);
    await this.channels.remove(slug, actorOf(claims), clientOf(request));
  }

  @Put(':slug/members/:userId')
  async setRole(
    @Param('slug') slug: string,
    @Param('userId') userId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() claims: AccessClaims | undefined,
    @Req() request: Request,
  ): Promise<ChannelDetail> {
    checkSlug(slug);
    const role = readString(body.role, 'role');
    if (!MEMBER_ROLES.includes(role as ChannelMemberRole)) {
      throw badRequest('invalid_request', 'Papel inválido.');
    }
    return this.channels.setMemberRole(
      slug,
      userId,
      role as ChannelMemberRole,
      actorOf(claims),
      clientOf(request),
    );
  }

  @Delete(':slug/members/:userId')
  async removeMember(
    @Param('slug') slug: string,
    @Param('userId') userId: string,
    @CurrentUser() claims: AccessClaims | undefined,
    @Req() request: Request,
  ): Promise<ChannelDetail> {
    checkSlug(slug);
    return this.channels.removeMember(slug, userId, actorOf(claims), clientOf(request));
  }

  // -------------------------------------------------------------------------
  // Salas dentro do canal
  // -------------------------------------------------------------------------

  @Put(':slug/rooms/:roomSlug')
  async addRoom(
    @Param('slug') slug: string,
    @Param('roomSlug') roomSlug: string,
    @CurrentUser() claims: AccessClaims | undefined,
    @Req() request: Request,
  ): Promise<ChannelDetail> {
    checkSlug(slug);
    check(validateRoomId(roomSlug));
    return this.channels.addRoom(slug, roomSlug, actorOf(claims), clientOf(request));
  }

  @Delete(':slug/rooms/:roomSlug')
  async removeRoom(
    @Param('slug') slug: string,
    @Param('roomSlug') roomSlug: string,
    @CurrentUser() claims: AccessClaims | undefined,
    @Req() request: Request,
  ): Promise<ChannelDetail> {
    checkSlug(slug);
    check(validateRoomId(roomSlug));
    return this.channels.removeRoom(slug, roomSlug, actorOf(claims), clientOf(request));
  }

  @Put(':slug/rooms')
  async reorderRooms(
    @Param('slug') slug: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() claims: AccessClaims | undefined,
    @Req() request: Request,
  ): Promise<ChannelDetail> {
    checkSlug(slug);
    if (!Array.isArray(body.order) || !body.order.every((item) => typeof item === 'string')) {
      throw badRequest('invalid_request', 'Campo "order" precisa ser uma lista de slugs.');
    }
    return this.channels.reorderRooms(
      slug,
      body.order as string[],
      actorOf(claims),
      clientOf(request),
    );
  }
}

// ---------------------------------------------------------------------------
// Mesmas funções de leitura de corpo do `RoomsController`, sem duplicar a
// implementação — que continua lá porque é ela que já é exportada e usada
// pelo módulo de sons.
// ---------------------------------------------------------------------------

function check(error: string | null): void {
  if (error !== null) throw badRequest('invalid_request', error);
}

function checkSlug(slug: string): void {
  check(validateRoomId(slug));
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw badRequest('invalid_request', `Campo "${field}" ausente ou inválido.`);
  }
  return value;
}

function readOptional(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw badRequest('invalid_request', 'Descrição inválida.');
  }
  return value;
}

function readEmoji(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw badRequest('invalid_request', 'Emoji inválido.');
  }
  const points = Array.from(value.trim());
  if (points.length === 0) return null;
  if (points.length > 3) {
    throw badRequest('invalid_request', 'Use no máximo um emoji.');
  }
  return points.join('');
}

function readVisibility(value: unknown): RoomVisibility | null {
  if (typeof value !== 'string') return null;
  return VISIBILITIES.includes(value as RoomVisibility) ? (value as RoomVisibility) : null;
}
