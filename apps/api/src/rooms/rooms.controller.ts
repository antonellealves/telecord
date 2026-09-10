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
  validateRoomDescription,
  validateRoomId,
  validateRoomName,
  type Page,
  type RoomDetail,
  type RoomMemberRole,
  type RoomSummary,
  type RoomVisibility,
} from '@telecord/shared';
import { CurrentUser, OptionalAuth, Public } from '../auth/auth.decorators';
import type { AccessClaims } from '../auth/tokens';
import { badRequest } from '../common/errors';
import { decodeCursor, parseLimit } from '../common/pagination';
import type { LogClient } from '../logging/log.service';
import { RoomsService, type Actor } from './rooms.service';

const VISIBILITIES: readonly RoomVisibility[] = ['PUBLIC', 'UNLISTED'];
const MEMBER_ROLES: readonly RoomMemberRole[] = ['OWNER', 'MOD', 'MEMBER'];

/**
 * Salas persistidas.
 *
 * ## Onde estas rotas moram, e por que não colidem com `api/rooms.ts`
 *
 * `GET /api/rooms` — sem barra e sem sufixo — continua sendo a função
 * serverless que lista as salas VIVAS no LiveKit. Ela não tem banco, não tem
 * dependência deste serviço e funciona com ele fora do ar; é de propósito, e é
 * ela que a tela inicial usa como base.
 *
 * Tudo abaixo de `/api/rooms/…` cai aqui, porque na Vercel um arquivo de
 * função casa com o caminho EXATO dele — sub-caminho sobra para a captura
 * `api/[...nest].ts`. As duas coisas convivem, e o passo de verificação do
 * deploy confere as duas para o dia em que isso deixar de ser verdade.
 *
 * ## Autorização
 *
 * O guard global cuida da sessão; o que ele não sabe é o papel DENTRO da sala,
 * que depende da linha no banco. Essa parte é do `RoomsService`, num método só
 * (`assertCanManage`), e nenhuma rota daqui decide permissão por conta própria.
 */
@Controller('rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Public()
  @Get('directory')
  async directory(
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<Page<RoomSummary>> {
    return this.rooms.directory(decodeCursor(cursor), parseLimit(limit));
  }

  @Get('mine')
  async mine(@CurrentUser() claims: AccessClaims | undefined): Promise<RoomSummary[]> {
    return this.rooms.mine(actorOf(claims).id);
  }

  /*
   * Opcional, e não pública: a resposta muda com quem pergunta — `myRole` só
   * existe para quem está logado —, mas exigir conta esconderia o nome da sala
   * de quem entra sem ela, que é a maioria.
   */
  @OptionalAuth()
  @Get(':slug')
  async detail(
    @Param('slug') slug: string,
    @CurrentUser() claims: AccessClaims | undefined,
  ): Promise<RoomDetail> {
    checkSlug(slug);
    return this.rooms.detail(slug, claims?.sub ?? null);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post()
  async create(
    @Body() body: Record<string, unknown>,
    @CurrentUser() claims: AccessClaims | undefined,
    @Req() request: Request,
  ): Promise<RoomDetail> {
    const slug = readString(body.slug, 'slug');
    const name = readString(body.name, 'name');
    checkSlug(slug);
    check(validateRoomName(name));

    const description = readOptional(body.description);
    if (description !== null) check(validateRoomDescription(description));

    return this.rooms.create(
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
  ): Promise<RoomDetail> {
    checkSlug(slug);

    const patch: Parameters<RoomsService['update']>[1] = {};
    if (body.name !== undefined) {
      const name = readString(body.name, 'name');
      check(validateRoomName(name));
      patch.name = name;
    }
    if (body.description !== undefined) {
      const description = readOptional(body.description);
      if (description !== null) check(validateRoomDescription(description));
      patch.description = description;
    }
    if (body.emoji !== undefined) patch.emoji = readEmoji(body.emoji);
    if (body.visibility !== undefined) {
      const visibility = readVisibility(body.visibility);
      if (visibility === null) throw badRequest('invalid_request', 'Visibilidade inválida.');
      patch.visibility = visibility;
    }

    return this.rooms.update(slug, patch, actorOf(claims), clientOf(request));
  }

  @Delete(':slug')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('slug') slug: string,
    @CurrentUser() claims: AccessClaims | undefined,
    @Req() request: Request,
  ): Promise<void> {
    checkSlug(slug);
    await this.rooms.remove(slug, actorOf(claims), clientOf(request));
  }

  @Put(':slug/members/:userId')
  async setRole(
    @Param('slug') slug: string,
    @Param('userId') userId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() claims: AccessClaims | undefined,
    @Req() request: Request,
  ): Promise<RoomDetail> {
    checkSlug(slug);
    const role = readString(body.role, 'role');
    if (!MEMBER_ROLES.includes(role as RoomMemberRole)) {
      throw badRequest('invalid_request', 'Papel inválido.');
    }
    return this.rooms.setMemberRole(
      slug,
      userId,
      role as RoomMemberRole,
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
  ): Promise<RoomDetail> {
    checkSlug(slug);
    return this.rooms.removeMember(slug, userId, actorOf(claims), clientOf(request));
  }
}

// ---------------------------------------------------------------------------
// Leitura do corpo. Mesmo formato do `auth.controller.ts`: a primeira falha
// corta, e a mensagem sai do contrato compartilhado — para o texto ser o mesmo
// que o navegador já mostrou antes de mandar.
// ---------------------------------------------------------------------------

export function actorOf(claims: AccessClaims | undefined): Actor {
  if (claims === undefined) {
    // O guard global não deixa chegar aqui sem sessão; isto existe para o caso
    // de alguém marcar a rota como pública e esquecer que ela lê o autor.
    throw badRequest('unauthorized', 'Faça login para continuar.');
  }
  return { id: claims.sub, displayName: claims.name, role: claims.role };
}

export function clientOf(request: Request): LogClient {
  return { ip: request.ip, userAgent: request.get('user-agent') ?? undefined };
}

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

/**
 * Um ou dois pontos de código, nada mais.
 *
 * O campo é `VARCHAR(16)`, e sem teto de contagem alguém cola um parágrafo de
 * emojis que cabe em 16 bytes e desmonta o alinhamento do card. Contar por
 * `Array.from` e não por `.length`: emoji é par substituto em UTF-16, e
 * `.length` diria 2 para um único símbolo.
 */
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
