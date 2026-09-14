import { Injectable, Logger } from '@nestjs/common';
import type { RoomActivityEventInput } from '@telecord/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { LogClient } from '../logging/log.service';
import { redactContext } from '../logging/redact';
import type { Prisma } from '../generated/prisma';
import type { ParticipantClaims } from '../livekit/participant-auth';

/** Eventos que o SERVIDOR testemunha diretamente — nunca o cliente reportando a si mesmo. */
export type ServerWitnessedEvent =
  | 'room.join'
  | 'room.leave'
  | 'moderation.muted'
  | 'moderation.moved'
  | 'moderation.removed';

/**
 * Persiste atividade de sala — chat, entrar/sair, mutar, compartilhar tela —
 * para QUALQUER participante, cadastrado ou não.
 *
 * Mesma garantia do `LogService`: nada aqui derruba a requisição. Um evento
 * de atividade que falha em gravar não é motivo para o cliente re-tentar
 * agressivamente nem para a UI mostrar erro — é observação, não parte do
 * fluxo da chamada.
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger('Telecord');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Eventos que o PRÓPRIO PARTICIPANTE reporta — chat, mutar/desmutar,
   * começar/parar de compartilhar tela — autenticados pelo token de
   * participante do LiveKit (ver `participant-auth.ts`). `identity` e
   * `room` vêm do token JÁ VERIFICADO, nunca do corpo da requisição: é o
   * que impede alguém de forjar uma fala em nome de outra pessoa.
   */
  async record(
    claims: ParticipantClaims,
    events: RoomActivityEventInput[],
    client: LogClient,
  ): Promise<void> {
    // `identity` casa com `User.id` do mesmo jeito que `LiveKitService.onJoin`
    // já faz para `MediaSession` — cuid e UUID têm formatos diferentes, então
    // a tentativa não arrisca casar a pessoa errada.
    const user = await this.prisma.user.findFirst({
      where: { id: claims.identity, deletedAt: null },
      select: { id: true },
    });
    const displayName = claims.name ?? claims.identity;

    for (const input of events) {
      try {
        await this.prisma.roomActivityLog.create({
          data: {
            roomSlug: claims.room,
            identity: claims.identity,
            userId: user?.id ?? null,
            displayName: displayName.slice(0, 64),
            event: input.event,
            body: input.event === 'chat' ? (input.body ?? '').slice(0, 400) : null,
            context: (redactContext({ occurredAt: input.occurredAt }) ??
              undefined) as Prisma.InputJsonValue | undefined,
            ip: client.ip?.slice(0, 45) ?? null,
            userAgent: client.userAgent?.slice(0, 255) ?? null,
          },
        });
      } catch (failure) {
        this.logger.error(`falha ao gravar atividade (${input.event}): ${describe(failure)}`);
      }
    }
  }

  /**
   * Registrado pelo próprio SERVIDOR — webhook do LiveKit
   * (`LiveKitService.onJoin`/`onLeave`) ou moderação (`ModerationService`) —
   * nunca pela rota de ingestão do cliente (`POST /activity/events`).
   * `room.join`/`room.leave` e a moderação sofrida não podem depender de o
   * cliente concordar em reportar a própria entrada, saída ou silenciamento.
   */
  async recordServerEvent(input: {
    roomSlug: string;
    identity: string;
    displayName: string;
    event: ServerWitnessedEvent;
    context?: Record<string, unknown>;
  }): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: input.identity, deletedAt: null },
      select: { id: true },
    });

    try {
      await this.prisma.roomActivityLog.create({
        data: {
          roomSlug: input.roomSlug,
          identity: input.identity,
          userId: user?.id ?? null,
          displayName: input.displayName.slice(0, 64),
          event: input.event,
          context: (redactContext(input.context) ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
    } catch (failure) {
      this.logger.error(`falha ao gravar evento de servidor (${input.event}): ${describe(failure)}`);
    }
  }
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
