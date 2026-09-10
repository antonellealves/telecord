import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { LogLevel } from '@telecord/shared';
import { PrismaService } from '../prisma/prisma.service';
import { redactContext, redactSnapshot } from './redact';

export interface LogClient {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface SystemLogInput {
  level: LogLevel;
  /** Módulo que escreve: `auth`, `rooms`, `sounds`, `livekit`, `admin`. */
  scope: string;
  /** Nome curto e ESTÁVEL do acontecimento: `login.ok`, `sound.upload`. */
  event: string;
  message: string;
  userId?: string | undefined;
  roomSlug?: string | undefined;
  context?: Record<string, unknown> | undefined;
  client?: LogClient | undefined;
}

export interface AuditInput {
  actorId: string | null;
  actorLabel: string;
  action: string;
  targetType: string;
  targetId: string;
  summary: string;
  before?: unknown;
  after?: unknown;
  client?: LogClient | undefined;
}

/**
 * Escrita do registro de eventos.
 *
 * Duas garantias, e as duas existem para que ninguém precise pensar nelas na
 * hora de chamar:
 *
 * 1. **Nada aqui derruba uma requisição.** Falha de escrita de log é engolida e
 *    reportada no logger do processo. Um `INSERT` de log que estoura o teto de
 *    conexões não pode transformar um login que funcionou num erro 500 — o
 *    log é observação, não parte da transação de negócio.
 * 2. **Nada escapa da redação.** Contexto e snapshots passam obrigatoriamente
 *    por `redact.ts`. Não existe caminho que escreva `context` cru.
 *
 * O nível ERROR e WARN também vai para o logger do processo, e não só para o
 * banco: quando o problema É o banco, a linha precisa aparecer em algum lugar.
 */
@Injectable()
export class LogService {
  private readonly logger = new Logger('Telecord');

  constructor(private readonly prisma: PrismaService) {}

  async record(input: SystemLogInput): Promise<void> {
    const line = `[${input.scope}] ${input.event}: ${input.message}`;
    if (input.level === 'ERROR') {
      this.logger.error(line);
    } else if (input.level === 'WARN') {
      this.logger.warn(line);
    }

    try {
      await this.prisma.systemLog.create({
        data: {
          level: input.level,
          scope: input.scope.slice(0, 32),
          event: input.event.slice(0, 64),
          message: input.message.slice(0, 500),
          userId: input.userId ?? null,
          roomSlug: input.roomSlug?.slice(0, 64) ?? null,
          ip: input.client?.ip?.slice(0, 45) ?? null,
          userAgent: input.client?.userAgent?.slice(0, 255) ?? null,
          // O tipo do Prisma para JSON é recursivo e não aceita
          // `Record<string, unknown>` sem afirmação; o valor já passou pela
          // redação, que é a garantia que importa aqui.
          context: (redactContext(input.context) ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
    } catch (failure) {
      this.logger.error(`falha ao gravar log: ${describe(failure)}`);
    }
  }

  async audit(input: AuditInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: input.actorId,
          actorLabel: input.actorLabel.slice(0, 64),
          action: input.action.slice(0, 48),
          targetType: input.targetType.slice(0, 32),
          targetId: input.targetId.slice(0, 64),
          summary: input.summary.slice(0, 300),
          before: (redactSnapshot(input.before) ?? undefined) as Prisma.InputJsonValue | undefined,
          after: (redactSnapshot(input.after) ?? undefined) as Prisma.InputJsonValue | undefined,
          ip: input.client?.ip?.slice(0, 45) ?? null,
          userAgent: input.client?.userAgent?.slice(0, 255) ?? null,
        },
      });
    } catch (failure) {
      // Auditoria perdida é grave o bastante para gritar no log do processo,
      // mas ainda assim não é motivo para derrubar a ação que ela descreve:
      // a ação já aconteceu, e devolver erro agora só mentiria para quem pediu.
      this.logger.error(`falha ao gravar auditoria (${input.action}): ${describe(failure)}`);
    }
  }
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
