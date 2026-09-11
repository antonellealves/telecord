import { Injectable } from '@nestjs/common';
import type { ChannelMemberRole, Prisma } from '../generated/prisma';
import {
  CHANNEL_ROOM_LIMIT,
  normalizeDisplayName,
  normalizeRoomId,
  type ChannelDetail,
  type ChannelSummary,
  type Page,
  type RoomVisibility,
} from '@telecord/shared';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { buildPage, encodeCursor, keysetBefore, type Keyset } from '../common/pagination';
import { LogService, type LogClient } from '../logging/log.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Actor } from '../rooms/rooms.service';

interface ChannelCounts {
  members: number;
  rooms: number;
}

/** Ordem dos papéis de canal, do mais para o menos poderoso — igual a `RANK` de `RoomsService`. */
const RANK: Record<ChannelMemberRole, number> = { OWNER: 3, MOD: 2, MEMBER: 1 };

/**
 * Canais: agrupadores de salas transitáveis.
 *
 * ## O que um canal É, na prática
 *
 * Metadado e uma lista ordenada (`Room.position`) de salas que pertencem a
 * ele. NÃO é uma sala em si — entrar num canal não conecta a lugar nenhum.
 * Cada sala dentro continua sendo uma `Room` LiveKit própria; "transitar"
 * entre salas de um canal é, tecnicamente, sair de uma conexão e entrar na
 * outra — a UI só torna esse salto de um clique, sem passar pela tela
 * inicial. Essa decisão está registrada no PLANO.md.
 *
 * ## Por que a hierarquia de papel é SEPARADA da de sala
 *
 * `ChannelMemberRole` governa criar/renomear salas do canal e mexer nos
 * membros DO CANAL. Não confundir com `RoomMemberRole`, que é o papel dentro
 * de uma sala específica. Promover alguém a MOD do canal não o torna MOD
 * automático de nenhuma sala existente dentro — mesclar as duas faria uma
 * promoção no canal ter um raio de efeito silencioso sobre salas que já têm
 * dono próprio, o que ninguém pediu.
 *
 * ## Dono, e por que criar sala dentro não dá posse do canal
 *
 * Simétrico ao motivo de `Sound` não dar posse de `Room` (ver
 * `RoomsService`): quem cria uma sala DENTRO de um canal vira dono DAQUELA
 * sala (via `RoomsService.create`), mas isso não muda nada no canal. Virar
 * dono do canal é ato explícito, por `POST /channels`.
 */
@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly log: LogService,
  ) {}

  // -------------------------------------------------------------------------
  // Leitura
  // -------------------------------------------------------------------------

  async directory(cursor: Keyset | null, limit: number): Promise<Page<ChannelSummary>> {
    const rows = await this.prisma.channel.findMany({
      where: {
        deletedAt: null,
        visibility: 'PUBLIC',
        ...(keysetBefore(cursor, 'createdAt') as Prisma.ChannelWhereInput),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const counts = await this.countsFor(rows.map((channel) => channel.id));
    return buildPage(
      rows,
      limit,
      (channel) => this.toSummary(channel, counts.get(channel.id)),
      (channel) => encodeCursor(channel.createdAt, channel.id),
    );
  }

  async mine(userId: string): Promise<ChannelSummary[]> {
    const memberships = await this.prisma.channelMember.findMany({
      where: { userId, channel: { deletedAt: null } },
      include: { channel: true },
      orderBy: { channel: { createdAt: 'desc' } },
      take: 50,
    });

    const channels = memberships.map((membership) => membership.channel);
    const counts = await this.countsFor(channels.map((channel) => channel.id));
    return channels.map((channel) => this.toSummary(channel, counts.get(channel.id)));
  }

  async detail(slug: string, viewerId: string | null): Promise<ChannelDetail> {
    const channel = await this.findBySlug(slug);
    const [counts, members, rooms] = await Promise.all([
      this.countsFor([channel.id]),
      this.prisma.channelMember.findMany({
        where: { channelId: channel.id },
        include: { user: { select: { id: true, displayName: true, avatarUrl: true } } },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
        take: 100,
      }),
      this.prisma.room.findMany({
        where: { channelId: channel.id, deletedAt: null },
        select: { slug: true, name: true, emoji: true, position: true },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        take: CHANNEL_ROOM_LIMIT,
      }),
    ]);

    const mine = members.find((member) => member.userId === viewerId);
    return {
      ...this.toSummary(channel, counts.get(channel.id)),
      myRole: mine?.role ?? null,
      members: members.map((member) => ({
        userId: member.userId,
        displayName: member.user.displayName,
        avatarUrl: member.user.avatarUrl,
        role: member.role,
        joinedAt: member.createdAt.toISOString(),
      })),
      rooms,
    };
  }

  // -------------------------------------------------------------------------
  // Escrita
  // -------------------------------------------------------------------------

  async create(
    input: {
      slug: string;
      name: string;
      description: string | null;
      emoji: string | null;
      visibility: RoomVisibility;
    },
    actor: Actor,
    client: LogClient,
  ): Promise<ChannelDetail> {
    const slug = normalizeRoomId(input.slug);
    const existing = await this.prisma.channel.findUnique({ where: { slug } });
    if (existing !== null && existing.deletedAt === null) {
      throw conflict('channel_taken', 'Já existe um canal com este endereço.');
    }

    const channel = await this.prisma.$transaction(async (tx) => {
      const created = await tx.channel.upsert({
        where: { slug },
        create: {
          slug,
          name: normalizeDisplayName(input.name),
          description: emptyToNull(input.description),
          emoji: emptyToNull(input.emoji),
          visibility: input.visibility,
          ownerId: actor.id,
        },
        // Como em `Room`: reviver pelo mesmo slug é possível, com dono novo e
        // sem os membros antigos — o `deletedAt` acima já garante que só
        // chegamos aqui quando a linha existente estava apagada.
        update: {
          name: normalizeDisplayName(input.name),
          description: emptyToNull(input.description),
          emoji: emptyToNull(input.emoji),
          visibility: input.visibility,
          ownerId: actor.id,
          deletedAt: null,
        },
      });
      await tx.channelMember.upsert({
        where: { channelId_userId: { channelId: created.id, userId: actor.id } },
        create: { channelId: created.id, userId: actor.id, role: 'OWNER' },
        update: { role: 'OWNER' },
      });
      return created;
    });

    await this.log.audit({
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: 'channel.create',
      targetType: 'channel',
      targetId: channel.slug,
      summary: `criou o canal ${channel.slug}`,
      after: { name: channel.name, visibility: channel.visibility },
      client,
    });
    await this.log.record({
      level: 'INFO',
      scope: 'channels',
      event: 'channel.create',
      message: `canal ${channel.slug} criado`,
      userId: actor.id,
      client,
    });

    return this.detail(channel.slug, actor.id);
  }

  async update(
    slug: string,
    patch: { name?: string; description?: string | null; emoji?: string | null; visibility?: RoomVisibility },
    actor: Actor,
    client: LogClient,
  ): Promise<ChannelDetail> {
    const channel = await this.findBySlug(slug);
    await this.assertCanManage(channel.id, channel.ownerId, actor, 'MOD');

    const data: Prisma.ChannelUpdateInput = {};
    if (patch.name !== undefined) data.name = normalizeDisplayName(patch.name);
    if (patch.description !== undefined) data.description = emptyToNull(patch.description);
    if (patch.emoji !== undefined) data.emoji = emptyToNull(patch.emoji);
    if (patch.visibility !== undefined) data.visibility = patch.visibility;

    const updated = await this.prisma.channel.update({ where: { id: channel.id }, data });

    await this.log.audit({
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: 'channel.update',
      targetType: 'channel',
      targetId: channel.slug,
      summary: `alterou o canal ${channel.slug}`,
      before: { name: channel.name, visibility: channel.visibility },
      after: { name: updated.name, visibility: updated.visibility },
      client,
    });

    return this.detail(updated.slug, actor.id);
  }

  /** Exclusão lógica. As salas dentro NÃO são apagadas — só soltas do canal. */
  async remove(slug: string, actor: Actor, client: LogClient): Promise<void> {
    const channel = await this.findBySlug(slug);
    await this.assertCanManage(channel.id, channel.ownerId, actor, 'OWNER');

    await this.prisma.$transaction([
      this.prisma.channel.update({ where: { id: channel.id }, data: { deletedAt: new Date() } }),
      /*
       * Desvincula, não apaga. A sala continua existindo e entrável pelo slug
       * dela — o canal era só a organização em volta. Apagar a sala junto
       * derrubaria conversas e sons de gente que não tem nada a ver com o
       * canal ter sido apagado.
       */
      this.prisma.room.updateMany({
        where: { channelId: channel.id },
        data: { channelId: null, position: 0 },
      }),
    ]);

    await this.log.audit({
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: 'channel.delete',
      targetType: 'channel',
      targetId: channel.slug,
      summary: `apagou o canal ${channel.slug}`,
      before: { name: channel.name },
      client,
    });
  }

  async setMemberRole(
    slug: string,
    targetUserId: string,
    role: ChannelMemberRole,
    actor: Actor,
    client: LogClient,
  ): Promise<ChannelDetail> {
    const channel = await this.findBySlug(slug);
    await this.assertCanManage(channel.id, channel.ownerId, actor, 'OWNER');

    if (targetUserId === channel.ownerId && role !== 'OWNER') {
      throw badRequest('owner_locked', 'Passe a posse antes de mudar o papel do dono.');
    }

    const before = await this.prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId: channel.id, userId: targetUserId } },
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.channelMember.upsert({
        where: { channelId_userId: { channelId: channel.id, userId: targetUserId } },
        create: { channelId: channel.id, userId: targetUserId, role },
        update: { role },
      });
      if (role === 'OWNER') {
        await tx.channel.update({ where: { id: channel.id }, data: { ownerId: targetUserId } });
        if (channel.ownerId !== null && channel.ownerId !== targetUserId) {
          await tx.channelMember.updateMany({
            where: { channelId: channel.id, userId: channel.ownerId },
            data: { role: 'MOD' },
          });
        }
      }
    });

    await this.log.audit({
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: 'channel.member.role',
      targetType: 'channel',
      targetId: channel.slug,
      summary: `mudou o papel de um membro em ${channel.slug} para ${role}`,
      before: { userId: targetUserId, role: before?.role ?? null },
      after: { userId: targetUserId, role },
      client,
    });

    return this.detail(channel.slug, actor.id);
  }

  async removeMember(
    slug: string,
    targetUserId: string,
    actor: Actor,
    client: LogClient,
  ): Promise<ChannelDetail> {
    const channel = await this.findBySlug(slug);
    if (targetUserId !== actor.id) {
      await this.assertCanManage(channel.id, channel.ownerId, actor, 'MOD');
    }
    if (targetUserId === channel.ownerId) {
      throw badRequest('owner_locked', 'O dono não pode ser removido. Passe a posse antes.');
    }

    await this.prisma.channelMember.deleteMany({
      where: { channelId: channel.id, userId: targetUserId },
    });

    await this.log.audit({
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: 'channel.member.remove',
      targetType: 'channel',
      targetId: channel.slug,
      summary:
        targetUserId === actor.id
          ? `saiu de ${channel.slug}`
          : `removeu um membro de ${channel.slug}`,
      before: { userId: targetUserId },
      client,
    });

    return this.detail(channel.slug, actor.id);
  }

  // -------------------------------------------------------------------------
  // Salas dentro do canal
  // -------------------------------------------------------------------------

  /**
   * Move uma sala existente para dentro do canal, ou tira dela (channelId
   * null). Quem administra a MUDANÇA é quem administra o CANAL de destino —
   * e, ao tirar uma sala, quem administrava o canal de onde ela estava.
   *
   * A sala precisa já existir (`RoomsService.create` ou `ensureRoom`
   * primeiro); isto não cria sala nova, só reorganiza uma que já tem dono
   * próprio.
   */
  async addRoom(
    channelSlug: string,
    roomSlug: string,
    actor: Actor,
    client: LogClient,
  ): Promise<ChannelDetail> {
    const channel = await this.findBySlug(channelSlug);
    await this.assertCanManage(channel.id, channel.ownerId, actor, 'MOD');

    const room = await this.prisma.room.findFirst({
      where: { slug: normalizeRoomId(roomSlug), deletedAt: null },
    });
    if (room === null) {
      throw notFound('room_not_found', 'Esta sala não está registrada. Crie-a antes de acrescentar ao canal.');
    }
    if (room.channelId === channel.id) {
      return this.detail(channel.slug, actor.id);
    }
    if (room.channelId !== null) {
      throw conflict('room_in_channel', 'Esta sala já pertence a outro canal. Tire-a de lá primeiro.');
    }

    const count = await this.prisma.room.count({ where: { channelId: channel.id, deletedAt: null } });
    if (count >= CHANNEL_ROOM_LIMIT) {
      throw forbidden(
        'channel_room_limit',
        `Este canal chegou ao limite de ${CHANNEL_ROOM_LIMIT} salas.`,
      );
    }

    await this.prisma.room.update({
      where: { id: room.id },
      data: { channelId: channel.id, position: count },
    });

    await this.log.audit({
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: 'channel.room.add',
      targetType: 'channel',
      targetId: channel.slug,
      summary: `acrescentou a sala ${room.slug} ao canal ${channel.slug}`,
      after: { roomSlug: room.slug },
      client,
    });

    return this.detail(channel.slug, actor.id);
  }

  async removeRoom(
    channelSlug: string,
    roomSlug: string,
    actor: Actor,
    client: LogClient,
  ): Promise<ChannelDetail> {
    const channel = await this.findBySlug(channelSlug);
    await this.assertCanManage(channel.id, channel.ownerId, actor, 'MOD');

    const room = await this.prisma.room.findFirst({
      where: { slug: normalizeRoomId(roomSlug), channelId: channel.id, deletedAt: null },
    });
    if (room === null) {
      throw notFound('room_not_found', 'Esta sala não pertence a este canal.');
    }

    // A sala continua existindo, só solta do canal — mesma regra de
    // `remove()` quando o canal inteiro é apagado.
    await this.prisma.room.update({
      where: { id: room.id },
      data: { channelId: null, position: 0 },
    });

    await this.log.audit({
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: 'channel.room.remove',
      targetType: 'channel',
      targetId: channel.slug,
      summary: `tirou a sala ${room.slug} do canal ${channel.slug}`,
      before: { roomSlug: room.slug },
      client,
    });

    return this.detail(channel.slug, actor.id);
  }

  /**
   * Reordena as salas do canal para a ordem exata da lista dada. Substitui
   * TODAS as posições de uma vez — mais simples e mais barato do que mover
   * uma de cada vez com "sobe"/"desce", e o cliente já tem a lista completa
   * na tela para reordenar por arrastar-e-soltar.
   */
  async reorderRooms(
    channelSlug: string,
    orderedSlugs: string[],
    actor: Actor,
    client: LogClient,
  ): Promise<ChannelDetail> {
    const channel = await this.findBySlug(channelSlug);
    await this.assertCanManage(channel.id, channel.ownerId, actor, 'MOD');

    const rooms = await this.prisma.room.findMany({
      where: { channelId: channel.id, deletedAt: null },
      select: { id: true, slug: true },
    });
    const bySlug = new Map(rooms.map((room) => [room.slug, room.id]));

    // A lista enviada precisa ser EXATAMENTE o conjunto de salas do canal —
    // nem a mais (sala de outro canal se infiltrando), nem a menos (uma
    // ficaria com a posição velha e a ordenação toda ficaria incoerente).
    if (orderedSlugs.length !== rooms.length || !orderedSlugs.every((slug) => bySlug.has(slug))) {
      throw badRequest('invalid_order', 'A lista precisa conter exatamente as salas deste canal.');
    }

    await this.prisma.$transaction(
      orderedSlugs.map((slug, index) =>
        this.prisma.room.update({
          where: { id: bySlug.get(slug) },
          data: { position: index },
        }),
      ),
    );

    // Reordenar é uma ação de baixo risco (não apaga nada, é reversível com
    // outra chamada), então vai só para o log técnico — a auditoria fica para
    // atos que mudam posse, papel ou existência de algo.
    await this.log.record({
      level: 'INFO',
      scope: 'channels',
      event: 'channel.rooms.reorder',
      message: `salas do canal ${channel.slug} reordenadas`,
      userId: actor.id,
      client,
    });

    return this.detail(channel.slug, actor.id);
  }

  // -------------------------------------------------------------------------
  // Internos
  // -------------------------------------------------------------------------

  async findBySlug(slug: string) {
    const channel = await this.prisma.channel.findFirst({
      where: { slug: normalizeRoomId(slug), deletedAt: null },
    });
    if (channel === null) {
      throw notFound('channel_not_found', 'Este canal não está registrado.');
    }
    return channel;
  }

  /** Mesma forma de `RoomsService.assertCanManage`: admin global passa por cima. */
  async assertCanManage(
    channelId: string,
    ownerId: string | null,
    actor: Actor,
    minimum: ChannelMemberRole,
  ): Promise<void> {
    if (actor.role === 'ADMIN') return;
    if (ownerId === actor.id) return;

    const member = await this.prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId: actor.id } },
    });
    if (member === null || RANK[member.role] < RANK[minimum]) {
      throw forbidden('forbidden', 'Você não administra este canal.');
    }
  }

  private async countsFor(channelIds: string[]): Promise<Map<string, ChannelCounts>> {
    const counts = new Map<string, ChannelCounts>();
    if (channelIds.length === 0) return counts;

    const [members, rooms] = await Promise.all([
      this.prisma.channelMember.groupBy({
        by: ['channelId'],
        where: { channelId: { in: channelIds } },
        _count: { _all: true },
      }),
      this.prisma.room.groupBy({
        by: ['channelId'],
        where: { channelId: { in: channelIds }, deletedAt: null },
        _count: { _all: true },
      }),
    ]);

    for (const id of channelIds) counts.set(id, { members: 0, rooms: 0 });
    for (const row of members) {
      const current = counts.get(row.channelId);
      if (current !== undefined) current.members = row._count._all;
    }
    for (const row of rooms) {
      if (row.channelId === null) continue;
      const current = counts.get(row.channelId);
      if (current !== undefined) current.rooms = row._count._all;
    }
    return counts;
  }

  private toSummary(
    channel: { slug: string; name: string; description: string | null; emoji: string | null; visibility: RoomVisibility; createdAt: Date },
    counts: ChannelCounts | undefined,
  ): ChannelSummary {
    return {
      slug: channel.slug,
      name: channel.name,
      description: channel.description,
      emoji: channel.emoji,
      visibility: channel.visibility,
      memberCount: counts?.members ?? 0,
      roomCount: counts?.rooms ?? 0,
      createdAt: channel.createdAt.toISOString(),
    };
  }
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

