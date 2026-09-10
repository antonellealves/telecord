import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RoomsService } from '../rooms/rooms.service';
import { LogService } from '../logging/log.service';
import type { LiveKitWebhookEvent } from './webhook-auth';

/**
 * O que fazer com um evento do LiveKit já verificado.
 *
 * ## Por que a sessão é medida aqui, e não no navegador
 *
 * "Minutos de conversa" é o indicador principal do painel, e o cliente é a
 * pior fonte possível para ele: a aba fecha sem avisar, a rede cai no meio, e
 * qualquer pessoa com o devtools aberto reporta o número que quiser. O SFU sabe
 * de verdade quem entrou e quando saiu, porque é ele quem mantém a conexão.
 *
 * ## Idempotência
 *
 * O LiveKit reentrega o webhook quando não recebe 200. A entrada é protegida
 * pelo `joinEventId` único — a segunda entrega do mesmo evento colide e é
 * ignorada. A saída fecha "a sessão aberta desta identidade nesta sala", que é
 * naturalmente idempotente: na segunda vez não há sessão aberta para fechar.
 */
@Injectable()
export class LiveKitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rooms: RoomsService,
    private readonly log: LogService,
  ) {}

  async handle(event: LiveKitWebhookEvent): Promise<void> {
    switch (event.event) {
      case 'participant_joined':
        await this.onJoin(event);
        return;
      case 'participant_left':
        await this.onLeave(event);
        return;
      case 'room_finished':
        await this.onRoomFinished(event);
        return;
      default:
        // `track_published`, `egress_*` e companhia não interessam ao painel.
        // Ignorar em silêncio, e responder 200: erro faria o LiveKit reentregar
        // para sempre um evento que nunca vamos querer.
        return;
    }
  }

  private async onJoin(event: LiveKitWebhookEvent): Promise<void> {
    if (event.roomName === null || event.participantIdentity === null) return;

    const joinedAt = new Date(event.createdAt);
    const roomId = await this.rooms.touch(event.roomName, joinedAt);

    /*
     * `identity` é o id do usuário para quem entrou com conta, e um UUID
     * avulso para quem entrou anônimo (ver `api/token.ts`). Como o cuid do
     * `User` e o UUID têm formatos diferentes, dá para tentar a associação sem
     * risco de confundir uma pessoa com outra — mas a confirmação vem do
     * banco, não do formato.
     */
    const user = await this.prisma.user.findFirst({
      where: { id: event.participantIdentity, deletedAt: null },
      select: { id: true },
    });

    try {
      await this.prisma.mediaSession.create({
        data: {
          roomSlug: event.roomName,
          roomId,
          identity: event.participantIdentity,
          userId: user?.id ?? null,
          participantName: event.participantName ?? event.participantIdentity,
          joinedAt,
          joinEventId: event.id,
        },
      });
    } catch {
      // Colisão de `joinEventId`: entrega repetida do mesmo evento. É o
      // caminho normal quando o LiveKit não recebe o 200 a tempo.
      return;
    }
  }

  private async onLeave(event: LiveKitWebhookEvent): Promise<void> {
    if (event.roomName === null || event.participantIdentity === null) return;
    const leftAt = new Date(event.createdAt);

    const open = await this.prisma.mediaSession.findFirst({
      where: {
        roomSlug: event.roomName,
        identity: event.participantIdentity,
        leftAt: null,
      },
      orderBy: { joinedAt: 'desc' },
    });
    if (open === null) return;

    await this.prisma.mediaSession.update({
      where: { id: open.id },
      data: {
        leftAt,
        durationSeconds: durationBetween(open.joinedAt, leftAt),
      },
    });
  }

  /**
   * Sala encerrada: fecha o que ficou aberto.
   *
   * Existe porque `participant_left` pode se perder — entrega falha, instância
   * reiniciando, rede entre o LiveKit e a Vercel. Sem esta varredura, uma
   * sessão órfã ficaria aberta para sempre e nunca entraria na conta de
   * minutos, que é justamente o número que o painel mostra.
   */
  private async onRoomFinished(event: LiveKitWebhookEvent): Promise<void> {
    if (event.roomName === null) return;
    const endedAt = new Date(event.createdAt);

    const open = await this.prisma.mediaSession.findMany({
      where: { roomSlug: event.roomName, leftAt: null },
      select: { id: true, joinedAt: true },
      take: 200,
    });
    if (open.length === 0) return;

    for (const session of open) {
      await this.prisma.mediaSession.update({
        where: { id: session.id },
        data: { leftAt: endedAt, durationSeconds: durationBetween(session.joinedAt, endedAt) },
      });
    }

    await this.log.record({
      level: 'INFO',
      scope: 'livekit',
      event: 'room.finished',
      message: `sala ${event.roomName} encerrada; ${open.length} sessão(ões) fechada(s)`,
      roomSlug: event.roomName,
    });
  }
}

/**
 * Duração em segundos, nunca negativa.
 *
 * O relógio do SFU e o desta máquina não são o mesmo, e uma saída pode chegar
 * com data anterior à entrada por alguns milissegundos. Um valor negativo aqui
 * envenenaria a soma de minutos do painel inteiro.
 */
function durationBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
}
