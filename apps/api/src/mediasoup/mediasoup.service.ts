import { Inject, Injectable } from '@nestjs/common';
import {
  MAX_CHAT_LENGTH,
  signPresenceToken,
  type LiveRoom,
  type MediasoupBroadcastEntry,
  type MediasoupBroadcastPollResult,
  type MediasoupClientConfig,
  type MediasoupConnectTransportBody,
  type MediasoupConsumeBody,
  type MediasoupConsumeResult,
  type MediasoupCreateTransportBody,
  type MediasoupProduceBody,
  type MediasoupProduceResult,
  type MediasoupTransportInfo,
} from '@telecord/shared';
import { CONFIG, type AppConfig } from '../common/config';
import { badRequest, forbidden } from '../common/errors';
import { PeersService } from '../peers/peers.service';
import { PrismaService } from '../prisma/prisma.service';
import { MediasoupSfuClient } from './mediasoup-sfu.client';

/** Vida do token de presença — curta de propósito, ver docstring de `presenceToken.ts`. */
const PRESENCE_TOKEN_TTL_MS = 120_000;

/** Mesma janela do cfsfu e do P2P: só quem renovou presença recentemente conta como na sala. */
const PRESENCE_TTL_MS = 20_000;

/** Mensagem sem quem busque vira lixo depois disso — mesma folga do TTL da tabela. */
const BROADCAST_TTL_MS = 60 * 60 * 1000;

/** Teto por chamada de leitura — sala ativa não devolve histórico ilimitado de uma vez. */
const BROADCAST_POLL_LIMIT = 100;

/**
 * Orquestra o processo mediasoup-sfu para o telecord.
 *
 * Mesmo papel do `CfsfuService`: fica entre o controller e o cliente HTTP,
 * confere que quem chama pertence à sala (o SFU não tem noção de sala nem de
 * quem tem permissão de entrar — só quem tem `peerId` e fala o protocolo) e
 * repassa a chamada.
 */
@Injectable()
export class MediasoupService {
  constructor(
    private readonly client: MediasoupSfuClient,
    private readonly prisma: PrismaService,
    private readonly peers: PeersService,
    @Inject(CONFIG) private readonly appConfig: AppConfig,
  ) {}

  /**
   * Salas mediasoup com gente dentro AGORA — direto da memória do SFU
   * (`RoomRegistry.listRoomsWithPresence`, via `GET /rooms/presence`), não
   * mais de `PeerPresence`/Prisma: presença ao vivo do mediasoup é evento
   * real (Socket.IO) desde que o canal `/presence` existe, sem TTL de 20s
   * para decidir quem ainda está dentro. Usado tanto pela Home pública
   * (`GET /mediasoup/live-rooms`, contagem para o badge) quanto pelo painel
   * admin (`MediasoupModerationService.liveRooms`, que chama isto para não
   * duplicar a agregação).
   */
  async liveRooms(): Promise<LiveRoom[]> {
    const rooms = await this.client.liveRoomsPresence();
    return rooms
      .map((room) => ({
        slug: room.slug,
        participants: room.participants,
        createdAt: room.earliestJoinedAt,
        transport: 'MEDIASOUP' as const,
      }))
      .sort((a, b) => b.participants - a.participants || a.slug.localeCompare(b.slug));
  }

  /**
   * Config pública da sala + token de presença de curta duração (ver
   * `presenceToken.ts`) para o navegador abrir o canal Socket.IO direto no
   * mediasoup-sfu. O heartbeat aqui é o ÚNICO que resta no fluxo HTTP: dá a
   * `assertMember` uma linha de `PeerPresence` fresca ANTES de assinar o
   * token — emitir o token sem essa prova deixaria qualquer um entrar numa
   * sala sem ter passado pela portaria. Depois disto, o browser não faz mais
   * polling de roster: quem mantém presença é o socket.
   */
  async clientConfig(
    roomSlug: string,
    peerId: string,
    displayName: string,
    userId: string | null,
  ): Promise<MediasoupClientConfig> {
    if (!this.client.enabled || this.appConfig.mediasoup === null) {
      return { enabled: false, routerRtpCapabilities: null, presenceToken: null };
    }
    await this.peers.heartbeat(roomSlug, peerId, displayName, userId, null, null);
    const routerRtpCapabilities = await this.client.routerRtpCapabilities(roomSlug);
    const presenceToken = await signPresenceToken({
      peerId,
      roomSlug,
      displayName,
      secret: this.appConfig.mediasoup.internalSecret,
      ttlMs: PRESENCE_TOKEN_TTL_MS,
    });
    return { enabled: true, routerRtpCapabilities, presenceToken };
  }

  async createTransport(
    roomSlug: string,
    body: MediasoupCreateTransportBody,
  ): Promise<MediasoupTransportInfo> {
    await this.assertMember(roomSlug, body.peerId);
    return this.client.createTransport(roomSlug, body);
  }

  async connectTransport(
    roomSlug: string,
    transportId: string,
    body: MediasoupConnectTransportBody,
  ): Promise<void> {
    await this.assertMember(roomSlug, body.peerId);
    await this.client.connectTransport(roomSlug, transportId, body);
  }

  async produce(
    roomSlug: string,
    transportId: string,
    body: MediasoupProduceBody,
  ): Promise<MediasoupProduceResult> {
    await this.assertMember(roomSlug, body.peerId);
    return this.client.produce(roomSlug, transportId, body);
  }

  async consume(
    roomSlug: string,
    transportId: string,
    body: MediasoupConsumeBody,
  ): Promise<MediasoupConsumeResult> {
    await this.assertMember(roomSlug, body.peerId);
    return this.client.consume(roomSlug, transportId, body);
  }

  async resumeConsumer(roomSlug: string, consumerId: string, peerId: string): Promise<void> {
    await this.assertMember(roomSlug, peerId);
    await this.client.resumeConsumer(roomSlug, consumerId, peerId);
  }

  async leave(roomSlug: string, peerId: string): Promise<void> {
    // Sem `assertMember` aqui: sair é o que APAGA a presença (SPEC do modo
    // P2P), então a essa altura a checagem já falharia para quem está saindo
    // de verdade. `leave` do SFU precisa acontecer de qualquer forma.
    await this.client.leave(roomSlug, peerId);
  }

  /**
   * Chat/soundboard por polling — ver `RoomBroadcastMessage` no schema para o
   * porquê de não ser um DataChannel de verdade ainda.
   */
  async sendBroadcast(roomSlug: string, peerId: string, displayName: string, body: string): Promise<void> {
    await this.assertMember(roomSlug, peerId);
    if (body.length === 0 || body.length > MAX_CHAT_LENGTH * 4) {
      // *4: `body` aqui é o RoomMessage inteiro serializado (envelope +
      // texto), não só o texto do chat — MAX_CHAT_LENGTH sozinho recusaria
      // toda mensagem de verdade. `parseRoomMessage` do lado do cliente é
      // quem valida a FORMA; isto só impede um payload absurdo de sala.
      throw badRequest('mensagem_invalida', 'Mensagem de tamanho inválido.');
    }
    await this.prisma.roomBroadcastMessage.create({
      data: {
        roomSlug,
        fromPeer: peerId,
        displayName: displayName.slice(0, 64),
        body,
        expiresAt: new Date(Date.now() + BROADCAST_TTL_MS),
      },
    });
  }

  /**
   * O que chegou depois do cursor. Sem cursor, devolve vazio — a sala não
   * empresta histórico de antes de alguém ter entrado (mesma regra do chat
   * do LiveKit, que também não back-fila).
   */
  async pollBroadcast(roomSlug: string, peerId: string, since: string | null): Promise<MediasoupBroadcastPollResult> {
    await this.assertMember(roomSlug, peerId);

    const cursorDate = since === null ? new Date() : new Date(since);
    const rows = await this.prisma.roomBroadcastMessage.findMany({
      where: {
        roomSlug,
        createdAt: since === null ? undefined : { gt: cursorDate },
      },
      orderBy: { createdAt: 'asc' },
      take: BROADCAST_POLL_LIMIT,
    });

    const messages: MediasoupBroadcastEntry[] = rows.map((row) => ({
      id: row.id,
      fromPeer: row.fromPeer,
      displayName: row.displayName,
      body: row.body,
      createdAt: row.createdAt.toISOString(),
    }));

    const cursor = messages.length > 0 ? messages[messages.length - 1]!.createdAt : (since ?? new Date().toISOString());
    return { messages, cursor };
  }

  /** Mesma portaria do `CfsfuService.assertMember` — reaproveita o roster de presença. */
  private async assertMember(roomSlug: string, peerId: string): Promise<void> {
    const presente = await this.prisma.peerPresence.findFirst({
      where: {
        roomSlug,
        peerId,
        lastSeenAt: { gte: new Date(Date.now() - PRESENCE_TTL_MS) },
      },
      select: { id: true },
    });
    if (presente === null) {
      throw forbidden('fora_da_sala', 'Entre na sala antes de usar o mediasoup.');
    }
  }
}

