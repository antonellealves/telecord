import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  ROOM_ACTIVITY_BATCH_LIMIT,
  validateRoomActivityEvent,
  type RoomActivityEventInput,
} from '@telecord/shared';
import { Public } from '../auth/auth.decorators';
import { CONFIG, type AppConfig } from '../common/config';
import { badRequest, serviceUnavailable, unauthorized } from '../common/errors';
import { clientOf } from '../rooms/rooms.controller';
import { verifyParticipantToken } from '../livekit/participant-auth';
import { ActivityService } from './activity.service';

/**
 * Ingestão de atividade de sala — chat, entrar/sair, mutar, tela.
 *
 * `@Public()` porque quem chama pode não ter conta nenhuma: o crachá aqui
 * não é o cookie de sessão (`AuthGuard`, que não existe para anônimo), é o
 * MESMO token de participante do LiveKit que o cliente já carrega para
 * conectar na sala (ver `participant-auth.ts`). A verificação da assinatura
 * é o que impede um evento forjado em nome de outra identity.
 *
 * Em lote, não um evento por requisição: cliques e mensagens em rajada não
 * podem virar uma chamada HTTP cada — o cliente agrega e manda até
 * `ROOM_ACTIVITY_BATCH_LIMIT` de uma vez.
 */
@Controller('activity')
export class ActivityController {
  constructor(
    private readonly activity: ActivityService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('events')
  @HttpCode(HttpStatus.OK)
  // Mais permissivo que o default (120/min): uma sala movimentada gera
  // várias mensagens e trocas de estado por minuto, e batelada já reduz o
  // número de requisições — mas não é `@SkipThrottle()`, porque isto é
  // entrada do cliente, não um servidor confiável assinado como o webhook.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async ingest(
    @Req() request: Request,
    @Body() body: { events?: unknown },
  ): Promise<{ ok: true }> {
    const credentials = this.config.livekit;
    if (credentials === null) {
      throw serviceUnavailable(
        'livekit_not_configured',
        'Este serviço não tem as credenciais do LiveKit para conferir o token.',
      );
    }

    const check = await verifyParticipantToken(
      request.headers.authorization,
      credentials.apiKey,
      credentials.apiSecret,
    );
    if (!check.ok) {
      throw unauthorized('invalid_token', 'Token de participante inválido ou vencido.');
    }

    if (!Array.isArray(body.events) || body.events.length === 0) {
      throw badRequest('invalid_request', 'Informe ao menos um evento em "events".');
    }
    if (body.events.length > ROOM_ACTIVITY_BATCH_LIMIT) {
      throw badRequest(
        'batch_too_large',
        `No máximo ${ROOM_ACTIVITY_BATCH_LIMIT} eventos por requisição.`,
      );
    }

    const events: RoomActivityEventInput[] = [];
    for (const raw of body.events) {
      const error = validateRoomActivityEvent(raw);
      if (error !== null) throw badRequest('invalid_request', error);
      events.push(raw as RoomActivityEventInput);
    }

    await this.activity.record(check.claims, events, clientOf(request));
    return { ok: true };
  }
}
