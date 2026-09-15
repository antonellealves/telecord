import { Inject, Injectable } from '@nestjs/common';
import { signAdminPresenceToken, type LiveParticipant, type LiveRoom } from '@telecord/shared';
import { ActivityService } from '../activity/activity.service';
import { CONFIG, type AppConfig } from '../common/config';
import { badRequest, serviceUnavailable } from '../common/errors';
import { LogService } from '../logging/log.service';
import type { LogClient } from '../logging/log.service';
import { MediasoupSfuClient } from '../mediasoup/mediasoup-sfu.client';
import { MediasoupService } from '../mediasoup/mediasoup.service';
import { PeersService } from '../peers/peers.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Actor } from '../rooms/rooms.service';

/**
 * Janela do `PeerPresence`/Prisma, usada só por `assertPresent` (guarda de
 * mutar/mover/remover, que continua sobre a mesma tabela de sempre — fora do
 * escopo da migração de roster para o socket). NÃO é mais usada por
 * `liveParticipants`/`liveRooms`, que agora vêm da memória do SFU (ver
 * `MediasoupService.liveRooms`).
 */
const PRESENCE_TTL_MS = 20_000;

/** Vida do token de presença de admin — mesma folga curta do token de peer, ver `presenceToken.ts`. */
const PRESENCE_TOKEN_TTL_MS = 120_000;

/**
 * Poderes de moderação sobre a sala mediasoup VIVA.
 *
 * ## Por que isto não se parece com `ModerationService`
 *
 * O LiveKit tem um `RoomServiceClient` — um servidor de controle central que
 * muta, move e remove QUALQUER participante à força, sem cooperação do
 * cliente. O mediasoup daqui não tem equivalente: o SFU (`RoomRegistry`) só
 * sabe fechar transportes do PRÓPRIO peer que os abriu (`removePeer`), então:
 *
 * - `remove`/`removeRoom` são REAIS: fecham os transportes no SFU
 *   (`MediasoupSfuClient.leave`) e apagam a presença — a pessoa cai de
 *   verdade, igual ao LiveKit.
 * - `mute`/`move` são COOPERATIVOS: o comando fica escrito em
 *   `PeerPresence.adminCommand` e só tem efeito quando o cliente mediasoup o
 *   lê no PRÓXIMO heartbeat (até `TICK_MS` de atraso) e obedece por conta
 *   própria (`mediasoupConnection.ts`). Mesma ressalva que mutar já tinha no
 *   LiveKit — a pessoa pode desfazer —, estendida aqui também para mover.
 *
 * "Sala mediasoup viva" não tem fonte central como `listRooms()`: é inferida
 * agregando `PeerPresence` por `roomSlug`, filtrando quem anunciou
 * `meta.mediasoup` dentro do TTL de presença.
 */
@Injectable()
export class MediasoupModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly peers: PeersService,
    private readonly sfu: MediasoupSfuClient,
    private readonly mediasoup: MediasoupService,
    private readonly log: LogService,
    private readonly activity: ActivityService,
    @Inject(CONFIG) private readonly appConfig: AppConfig,
  ) {}

  /** Agregação de verdade mora em `MediasoupService.liveRooms` (reusada também pela Home pública). */
  async liveRooms(): Promise<LiveRoom[]> {
    return this.mediasoup.liveRooms();
  }

  /**
   * Quem está na sala mediasoup AGORA, direto da memória do SFU
   * (`this.sfu.roomPresence`) — não mais de `PeerPresence`/Prisma, que tinha
   * até 20s de atraso para refletir quem saiu. `adminCommand`/`userId`
   * (mute/move pendente, se é anônimo) continuam só no Prisma — busca-se por
   * `peerId IN (...)` da lista que já veio do SFU, sem depender do TTL para
   * decidir quem está dentro.
   */
  async liveParticipants(slug: string): Promise<LiveParticipant[]> {
    const presentes = await this.sfu.roomPresence(slug);
    if (presentes.length === 0) return [];

    const rows = await this.prisma.peerPresence.findMany({
      where: { roomSlug: slug, peerId: { in: presentes.map((p) => p.peerId) } },
      select: { peerId: true, userId: true, adminCommand: true },
    });
    const byPeerId = new Map(rows.map((row) => [row.peerId, row]));

    return presentes.map((peer) => {
      const row = byPeerId.get(peer.peerId);
      const command = isRecord(row?.adminCommand) ? row.adminCommand : null;
      return {
        identity: peer.peerId,
        displayName: peer.displayName,
        joinedAt: peer.joinedAt,
        isAnonymous: (row?.userId ?? null) === null,
        tracks: [],
        pendingCommand:
          command === null
            ? null
            : {
                forceMuted: command.forceMuted === true,
                moveTo: typeof command.moveTo === 'string' ? command.moveTo : null,
              },
      };
    });
  }

  /** Emitido só para quem já passou pelo guard de admin (ver `admin.controller.ts`) — o painel "Ao vivo" abre um socket com isto. */
  async issueAdminPresenceToken(actor: Actor): Promise<string> {
    if (this.appConfig.mediasoup === null) {
      throw serviceUnavailable('mediasoup_desligado', 'A opção mediasoup não está configurada neste servidor.');
    }
    return signAdminPresenceToken({
      actorId: actor.id,
      secret: this.appConfig.mediasoup.internalSecret,
      ttlMs: PRESENCE_TOKEN_TTL_MS,
    });
  }

  /** Cooperativo — ver docstring da classe. */
  async muteParticipant(
    slug: string,
    peerId: string,
    muted: boolean,
    actor: Actor,
    client: LogClient | undefined,
  ): Promise<void> {
    await this.assertPresent(slug, peerId);
    await this.peers.setAdminCommand(slug, peerId, muted ? { forceMuted: true } : { forceMuted: false });
    // Best-effort: entrega imediata a quem já está com o socket de presença
    // aberto. Se falhar (ex.: peer sem socket agora), o comando já está
    // salvo acima — só não chegou ao vivo desta vez.
    await this.sfu.pushCommand(slug, peerId, { forceMuted: muted }).catch(() => undefined);

    await this.log.audit({
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: muted ? 'moderacao.mutar' : 'moderacao.desmutar',
      targetType: 'participante',
      targetId: `${slug}/${peerId}`,
      summary: `${muted ? 'Pediu mudo para' : 'Liberou'} ${peerId} em ${slug} (mediasoup, cooperativo)`,
      after: { muted },
      client,
    });
    await this.activity.recordServerEvent({
      roomSlug: slug,
      identity: peerId,
      displayName: peerId,
      event: 'moderation.muted',
      context: { muted, por: actor.displayName, cooperativo: true },
    });
  }

  /** Cooperativo — ver docstring da classe. */
  async moveParticipant(
    slug: string,
    peerId: string,
    destino: string,
    actor: Actor,
    client: LogClient | undefined,
  ): Promise<void> {
    if (destino.trim() === '' || destino === slug) {
      throw badRequest('destino_invalido', 'Escolha uma sala diferente da atual.');
    }
    await this.assertPresent(slug, peerId);
    await this.peers.setAdminCommand(slug, peerId, { moveTo: destino });
    await this.sfu.pushCommand(slug, peerId, { moveTo: destino }).catch(() => undefined);

    await this.log.audit({
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: 'moderacao.mover',
      targetType: 'participante',
      targetId: `${slug}/${peerId}`,
      summary: `Pediu para mover ${peerId} de ${slug} para ${destino} (mediasoup, cooperativo)`,
      before: { sala: slug },
      after: { sala: destino },
      client,
    });
    await this.activity.recordServerEvent({
      roomSlug: slug,
      identity: peerId,
      displayName: peerId,
      event: 'moderation.moved',
      context: { destino, por: actor.displayName, cooperativo: true },
    });
  }

  /** Real — fecha os transportes do par no SFU e apaga a presença. */
  async removeParticipant(
    slug: string,
    peerId: string,
    actor: Actor,
    client: LogClient | undefined,
  ): Promise<void> {
    await this.assertPresent(slug, peerId);
    await this.sfu.leave(slug, peerId);
    await this.peers.leave(slug, peerId);

    await this.log.audit({
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: 'moderacao.remover',
      targetType: 'participante',
      targetId: `${slug}/${peerId}`,
      summary: `Removeu ${peerId} de ${slug} (mediasoup)`,
      before: { sala: slug, presente: true },
      after: { presente: false },
      client,
    });
    await this.activity.recordServerEvent({
      roomSlug: slug,
      identity: peerId,
      displayName: peerId,
      event: 'moderation.removed',
      context: { por: actor.displayName },
    });
  }

  /** Apaga a sala ao vivo inteira — kick em massa, um por um. Não apaga o registro da `Room` no banco. */
  async removeRoom(slug: string, actor: Actor, client: LogClient | undefined): Promise<number> {
    const people = await this.liveParticipants(slug);
    for (const person of people) {
      await this.removeParticipant(slug, person.identity, actor, client);
    }
    return people.length;
  }

  private async assertPresent(roomSlug: string, peerId: string): Promise<void> {
    const presente = await this.prisma.peerPresence.findFirst({
      where: {
        roomSlug,
        peerId,
        lastSeenAt: { gte: new Date(Date.now() - PRESENCE_TTL_MS) },
      },
      select: { id: true },
    });
    if (presente === null) {
      throw badRequest('participante_ausente', 'Essa pessoa não está mais na sala.');
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
