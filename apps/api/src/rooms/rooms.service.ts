import { Injectable } from '@nestjs/common';
import type { Prisma, Room, RoomMemberRole } from '../generated/prisma';
import {
  normalizeDisplayName,
  normalizeRoomId,
  type Page,
  type RoomDetail,
  type RoomSummary,
  type RoomVisibility,
} from '@telecord/shared';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { buildPage, encodeCursor, keysetBefore, type Keyset } from '../common/pagination';
import { LogService, type LogClient } from '../logging/log.service';
import { PrismaService } from '../prisma/prisma.service';

/** Quem está agindo. `role` é o papel GLOBAL (USER/ADMIN), não o da sala. */
export interface Actor {
  id: string;
  displayName: string;
  role: string;
}

interface RoomCounts {
  members: number;
  sounds: number;
}

/** Ordem dos papéis de sala, do mais para o menos poderoso. */
const RANK: Record<RoomMemberRole, number> = { OWNER: 3, MOD: 2, MEMBER: 1 };

/**
 * Salas persistidas.
 *
 * ## O que uma `Room` é, e o que ela não é
 *
 * É metadado: nome legível, descrição, emoji, dono, membros e o soundboard da
 * sala. NÃO é portaria. Entrar continua sendo função de ter a URL, exatamente
 * como antes desta tabela existir — e continua funcionando com este serviço
 * inteiro fora do ar, que é um requisito do produto (PLANO.md §6).
 *
 * Por isso os papéis daqui governam ADMINISTRAR a sala — renomear, apagar som
 * dos outros, mexer nos membros. Nenhum deles governa entrar.
 *
 * ## Dono, e por que enviar um som não dá posse
 *
 * A sala nasce sem dono quando alguém larga um som numa sala avulsa: o
 * `ensureRoom` cria a linha só para o som ter onde morar. Virar dono é ato
 * explícito, pelo `POST /rooms` — quem primeiro NOMEIA a sala fica com ela.
 *
 * A distinção existe para não criar tomada de terreno: se largar um arquivo
 * desse posse, bastava alguém passar em `dota` uma vez para todo o resto da
 * turma perder o direito de mexer na sala.
 */
@Injectable()
export class RoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly log: LogService,
  ) {}

  // -------------------------------------------------------------------------
  // Leitura
  // -------------------------------------------------------------------------

  /**
   * Diretório de salas nomeadas, da mais recentemente ativa para a mais antiga.
   *
   * `UNLISTED` não aparece — é literalmente o que a palavra diz, e a única
   * coisa que ela faz. A sala continua alcançável por quem tem o endereço.
   */
  async directory(cursor: Keyset | null, limit: number): Promise<Page<RoomSummary>> {
    const rows = await this.prisma.room.findMany({
      where: {
        deletedAt: null,
        visibility: 'PUBLIC',
        ...(keysetBefore(cursor, 'lastActiveAt') as Prisma.RoomWhereInput),
      },
      include: { channel: { select: { slug: true } } },
      orderBy: [{ lastActiveAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const counts = await this.countsFor(rows.map((room) => room.id));
    return buildPage(
      rows,
      limit,
      (room) => this.toSummary(room, counts.get(room.id), room.channel?.slug ?? null),
      (room) => encodeCursor(room.lastActiveAt, room.id),
    );
  }

  /** Salas em que esta pessoa é membro, para a tela inicial de quem tem conta. */
  async mine(userId: string): Promise<RoomSummary[]> {
    const memberships = await this.prisma.roomMember.findMany({
      where: { userId, room: { deletedAt: null } },
      include: { room: { include: { channel: { select: { slug: true } } } } },
      orderBy: { room: { lastActiveAt: 'desc' } },
      take: 50,
    });

    const rooms = memberships.map((membership) => membership.room);
    const counts = await this.countsFor(rooms.map((room) => room.id));
    return rooms.map((room) => this.toSummary(room, counts.get(room.id), room.channel?.slug ?? null));
  }

  async detail(slug: string, viewerId: string | null): Promise<RoomDetail> {
    const room = await this.findBySlug(slug);
    const [counts, members, channelSlug] = await Promise.all([
      this.countsFor([room.id]),
      this.prisma.roomMember.findMany({
        where: { roomId: room.id },
        include: { user: { select: { id: true, displayName: true, avatarUrl: true } } },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
        take: 100,
      }),
      // Consulta pontual, só quando a sala de fato pertence a um canal — o
      // caso comum (sala avulsa) não paga nada além do `null` já em mãos.
      room.channelId === null
        ? Promise.resolve(null)
        : this.prisma.channel
            .findUnique({ where: { id: room.channelId }, select: { slug: true } })
            .then((channel) => channel?.slug ?? null),
    ]);

    const mine = members.find((member) => member.userId === viewerId);
    return {
      ...this.toSummary(room, counts.get(room.id), channelSlug),
      myRole: mine?.role ?? null,
      members: members.map((member) => ({
        userId: member.userId,
        displayName: member.user.displayName,
        avatarUrl: member.user.avatarUrl,
        role: member.role,
        joinedAt: member.createdAt.toISOString(),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Escrita
  // -------------------------------------------------------------------------

  /**
   * Cria a sala, ou adota uma que ainda não tem dono.
   *
   * Adotar é o que fecha o buraco deixado pelo `ensureRoom`: a sala que nasceu
   * só para segurar um som fica disponível para quem quiser assumi-la de fato.
   * Com dono, só ele e um administrador mexem.
   */
  async create(
    input: { slug: string; name: string; description: string | null; emoji: string | null; visibility: RoomVisibility },
    actor: Actor,
    client: LogClient,
  ): Promise<RoomDetail> {
    const slug = normalizeRoomId(input.slug);
    const existing = await this.prisma.room.findUnique({ where: { slug } });

    if (existing !== null && existing.deletedAt === null) {
      if (existing.ownerId !== null && existing.ownerId !== actor.id && !isAdmin(actor)) {
        throw conflict('room_taken', 'Esta sala já tem dono. Fale com quem a criou.');
      }
      return this.applyUpdate(existing, input, actor, client, existing.ownerId === null);
    }

    const room = await this.prisma.$transaction(async (tx) => {
      const created = await tx.room.upsert({
        where: { slug },
        create: {
          slug,
          name: normalizeDisplayName(input.name),
          description: emptyToNull(input.description),
          emoji: emptyToNull(input.emoji),
          visibility: input.visibility,
          ownerId: actor.id,
        },
        // A sala pode existir com `deletedAt` preenchido: recriar pelo mesmo
        // slug ressuscita a linha, com dono novo e sem os membros antigos.
        update: {
          name: normalizeDisplayName(input.name),
          description: emptyToNull(input.description),
          emoji: emptyToNull(input.emoji),
          visibility: input.visibility,
          ownerId: actor.id,
          deletedAt: null,
        },
      });
      await tx.roomMember.upsert({
        where: { roomId_userId: { roomId: created.id, userId: actor.id } },
        create: { roomId: created.id, userId: actor.id, role: 'OWNER' },
        update: { role: 'OWNER' },
      });
      return created;
    });

    await this.log.audit({
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: 'room.create',
      targetType: 'room',
      targetId: room.slug,
      summary: `criou a sala ${room.slug}`,
      after: { name: room.name, visibility: room.visibility },
      client,
    });
    await this.log.record({
      level: 'INFO',
      scope: 'rooms',
      event: 'room.create',
      message: `sala ${room.slug} criada`,
      userId: actor.id,
      roomSlug: room.slug,
      client,
    });

    return this.detail(room.slug, actor.id);
  }

  async update(
    slug: string,
    patch: { name?: string; description?: string | null; emoji?: string | null; visibility?: RoomVisibility },
    actor: Actor,
    client: LogClient,
  ): Promise<RoomDetail> {
    const room = await this.findBySlug(slug);
    await this.assertCanManage(room, actor, 'MOD');
    return this.applyUpdate(room, patch, actor, client, false);
  }

  /** Exclusão lógica: a sala some do diretório e o slug volta a ser avulso. */
  async remove(slug: string, actor: Actor, client: LogClient): Promise<void> {
    const room = await this.findBySlug(slug);
    await this.assertCanManage(room, actor, 'OWNER');

    await this.prisma.room.update({
      where: { id: room.id },
      data: { deletedAt: new Date() },
    });

    await this.log.audit({
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: 'room.delete',
      targetType: 'room',
      targetId: room.slug,
      summary: `apagou a sala ${room.slug}`,
      before: { name: room.name, visibility: room.visibility },
      client,
    });
  }

  async setMemberRole(
    slug: string,
    targetUserId: string,
    role: RoomMemberRole,
    actor: Actor,
    client: LogClient,
  ): Promise<RoomDetail> {
    const room = await this.findBySlug(slug);
    await this.assertCanManage(room, actor, 'OWNER');

    if (targetUserId === room.ownerId && role !== 'OWNER') {
      // Rebaixar o dono deixaria a sala sem ninguém capaz de administrá-la —
      // um estado do qual só um administrador global tiraria depois.
      throw badRequest('owner_locked', 'Passe a posse antes de mudar o papel do dono.');
    }

    const before = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId: room.id, userId: targetUserId } },
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.roomMember.upsert({
        where: { roomId_userId: { roomId: room.id, userId: targetUserId } },
        create: { roomId: room.id, userId: targetUserId, role },
        update: { role },
      });
      if (role === 'OWNER') {
        // Só existe um dono. Quem promove outra pessoa passa a posse, e o
        // antigo dono continua na sala como moderador.
        await tx.room.update({ where: { id: room.id }, data: { ownerId: targetUserId } });
        if (room.ownerId !== null && room.ownerId !== targetUserId) {
          await tx.roomMember.updateMany({
            where: { roomId: room.id, userId: room.ownerId },
            data: { role: 'MOD' },
          });
        }
      }
    });

    await this.log.audit({
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: 'room.member.role',
      targetType: 'room',
      targetId: room.slug,
      summary: `mudou o papel de um membro em ${room.slug} para ${role}`,
      before: { userId: targetUserId, role: before?.role ?? null },
      after: { userId: targetUserId, role },
      client,
    });

    return this.detail(room.slug, actor.id);
  }

  async removeMember(
    slug: string,
    targetUserId: string,
    actor: Actor,
    client: LogClient,
  ): Promise<RoomDetail> {
    const room = await this.findBySlug(slug);
    // Sair da própria sala não precisa de cargo; tirar outra pessoa, sim.
    if (targetUserId !== actor.id) {
      await this.assertCanManage(room, actor, 'MOD');
    }
    if (targetUserId === room.ownerId) {
      throw badRequest('owner_locked', 'O dono não pode ser removido. Passe a posse antes.');
    }

    await this.prisma.roomMember.deleteMany({
      where: { roomId: room.id, userId: targetUserId },
    });

    await this.log.audit({
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: 'room.member.remove',
      targetType: 'room',
      targetId: room.slug,
      summary:
        targetUserId === actor.id ? `saiu de ${room.slug}` : `removeu um membro de ${room.slug}`,
      before: { userId: targetUserId },
      client,
    });

    return this.detail(room.slug, actor.id);
  }

  // -------------------------------------------------------------------------
  // Usado pelo módulo de sons
  // -------------------------------------------------------------------------

  /**
   * Devolve a `Room` do slug, criando uma SEM DONO se ainda não existir.
   *
   * A ausência de dono é o ponto: larguei um som numa sala avulsa, a sala
   * ganha uma linha para o som ter onde morar, e continua aberta para quem
   * quiser assumi-la depois pelo `POST /rooms`.
   */
  async ensureRoom(slug: string, actor: Actor, client: LogClient): Promise<Room> {
    const normalized = normalizeRoomId(slug);
    const existing = await this.prisma.room.findUnique({ where: { slug: normalized } });
    if (existing !== null && existing.deletedAt === null) {
      return existing;
    }

    const room = await this.prisma.room.upsert({
      where: { slug: normalized },
      create: { slug: normalized, name: normalized, ownerId: null },
      update: { deletedAt: null },
    });

    await this.log.record({
      level: 'INFO',
      scope: 'rooms',
      event: 'room.auto',
      message: `sala ${normalized} registrada sem dono para receber um som`,
      userId: actor.id,
      roomSlug: normalized,
      client,
    });
    return room;
  }

  async roleOf(roomId: string, userId: string | null): Promise<RoomMemberRole | null> {
    if (userId === null) return null;
    const member = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    return member?.role ?? null;
  }

  /** Entra na sala como membro simples, sem mexer em quem já tem cargo. */
  async joinAsMember(roomId: string, userId: string): Promise<void> {
    await this.prisma.roomMember.upsert({
      where: { roomId_userId: { roomId, userId } },
      create: { roomId, userId, role: 'MEMBER' },
      update: {},
    });
  }

  /** Marca atividade na sala. Chamado pelo webhook, quando alguém entra. */
  async touch(slug: string, at: Date): Promise<string | null> {
    const room = await this.prisma.room.findUnique({ where: { slug }, select: { id: true } });
    if (room === null) return null;
    await this.prisma.room.update({ where: { id: room.id }, data: { lastActiveAt: at } });
    return room.id;
  }

  // -------------------------------------------------------------------------
  // Internos
  // -------------------------------------------------------------------------

  async findBySlug(slug: string): Promise<Room> {
    const room = await this.prisma.room.findFirst({
      where: { slug: normalizeRoomId(slug), deletedAt: null },
    });
    if (room === null) {
      throw notFound('room_not_found', 'Esta sala não está registrada.');
    }
    return room;
  }

  /**
   * A verificação de permissão, num lugar só.
   *
   * Administrador global passa por cima de qualquer sala — é o que permite
   * limpar uma sala abandonada cujo dono sumiu. Está registrado na auditoria
   * como qualquer outro ato.
   */
  async assertCanManage(room: Room, actor: Actor, minimum: RoomMemberRole): Promise<void> {
    if (isAdmin(actor)) return;
    if (room.ownerId === actor.id) return;

    const role = await this.roleOf(room.id, actor.id);
    if (role === null || RANK[role] < RANK[minimum]) {
      throw forbidden('forbidden', 'Você não administra esta sala.');
    }
  }

  private async applyUpdate(
    room: Room,
    patch: { name?: string; description?: string | null; emoji?: string | null; visibility?: RoomVisibility },
    actor: Actor,
    client: LogClient,
    adopt: boolean,
  ): Promise<RoomDetail> {
    const data: Prisma.RoomUpdateInput = {};
    if (patch.name !== undefined) data.name = normalizeDisplayName(patch.name);
    if (patch.description !== undefined) data.description = emptyToNull(patch.description);
    if (patch.emoji !== undefined) data.emoji = emptyToNull(patch.emoji);
    if (patch.visibility !== undefined) data.visibility = patch.visibility;
    if (adopt) data.owner = { connect: { id: actor.id } };

    const updated = await this.prisma.room.update({ where: { id: room.id }, data });
    if (adopt) {
      await this.prisma.roomMember.upsert({
        where: { roomId_userId: { roomId: room.id, userId: actor.id } },
        create: { roomId: room.id, userId: actor.id, role: 'OWNER' },
        update: { role: 'OWNER' },
      });
    }

    await this.log.audit({
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: adopt ? 'room.adopt' : 'room.update',
      targetType: 'room',
      targetId: room.slug,
      summary: adopt ? `assumiu a sala ${room.slug}` : `alterou a sala ${room.slug}`,
      before: { name: room.name, description: room.description, visibility: room.visibility },
      after: {
        name: updated.name,
        description: updated.description,
        visibility: updated.visibility,
      },
      client,
    });

    return this.detail(updated.slug, actor.id);
  }

  /**
   * Contagens em duas consultas agregadas, e não uma por sala.
   *
   * `_count` embutido resolveria numa consulta só, mas não filtra som apagado
   * sem depender de recurso que muda de versão para versão do Prisma. Duas
   * agregações explícitas custam duas idas ao banco por PÁGINA — não por
   * linha — e o que elas contam fica escrito aqui, legível.
   */
  private async countsFor(roomIds: string[]): Promise<Map<string, RoomCounts>> {
    const counts = new Map<string, RoomCounts>();
    if (roomIds.length === 0) return counts;

    const [members, sounds] = await Promise.all([
      this.prisma.roomMember.groupBy({
        by: ['roomId'],
        where: { roomId: { in: roomIds } },
        _count: { _all: true },
      }),
      this.prisma.sound.groupBy({
        by: ['roomId'],
        where: { roomId: { in: roomIds }, deletedAt: null },
        _count: { _all: true },
      }),
    ]);

    for (const id of roomIds) counts.set(id, { members: 0, sounds: 0 });
    for (const row of members) {
      const current = counts.get(row.roomId);
      if (current !== undefined) current.members = row._count._all;
    }
    for (const row of sounds) {
      if (row.roomId === null) continue;
      const current = counts.get(row.roomId);
      if (current !== undefined) current.sounds = row._count._all;
    }
    return counts;
  }

  private toSummary(
    room: Room,
    counts: RoomCounts | undefined,
    channelSlug: string | null = null,
  ): RoomSummary {
    return {
      slug: room.slug,
      name: room.name,
      description: room.description,
      emoji: room.emoji,
      visibility: room.visibility,
      memberCount: counts?.members ?? 0,
      soundCount: counts?.sounds ?? 0,
      createdAt: room.createdAt.toISOString(),
      lastActiveAt: room.lastActiveAt.toISOString(),
      channelSlug,
    };
  }
}

function isAdmin(actor: Actor): boolean {
  return actor.role === 'ADMIN';
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
