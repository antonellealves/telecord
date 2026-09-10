import { Controller, HttpCode, HttpStatus, Inject, Post, Req } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../auth/auth.decorators';
import { CONFIG, type AppConfig } from '../common/config';
import { badRequest, serviceUnavailable, unauthorized } from '../common/errors';
import { BodyTooLargeError, RawBodyUnavailableError, readRawBody } from '../common/raw-body';
import { LogService } from '../logging/log.service';
import { LiveKitService } from './livekit.service';
import { verifyLiveKitWebhook } from './webhook-auth';

/** Evento do LiveKit é pequeno; o teto existe para não virar canal de entrada. */
const MAX_WEBHOOK_BYTES = 64 * 1024;

/**
 * Recebe os eventos do LiveKit.
 *
 * `@Public()` porque quem chama é o LiveKit, que não tem conta no telecord — a
 * autenticação desta rota é a assinatura do corpo, conferida em
 * `webhook-auth.ts`. É a única rota pública do serviço que ESCREVE, e por isso
 * a verificação vem antes de qualquer outra coisa, inclusive de olhar o
 * conteúdo.
 *
 * `@SkipThrottle()` porque o limitador contaria uma sala movimentada como
 * abuso: cada pessoa entrando e saindo é um evento, e barrar isso perderia
 * justamente os dados de pico. O teto de corpo e a assinatura são o que
 * protege a rota.
 *
 * ## Configuração no LiveKit Cloud
 *
 * Project → Settings → Webhooks → `https://telecord.vercel.app/api/livekit/webhook`.
 * Sem isso, nada chega aqui, a tabela de sessões fica vazia e o painel diz que
 * não há dado — que é o comportamento correto, e não zero disfarçado de número.
 */
@Controller('livekit')
export class LiveKitController {
  constructor(
    private readonly livekit: LiveKitService,
    private readonly log: LogService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @SkipThrottle()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async webhook(@Req() request: Request): Promise<{ ok: true }> {
    const credentials = this.config.livekit;
    if (credentials === null) {
      throw serviceUnavailable(
        'livekit_not_configured',
        'Este serviço não tem as credenciais do LiveKit para conferir a assinatura.',
      );
    }

    const body = await this.readBody(request);
    const check = await verifyLiveKitWebhook({
      authorization: request.headers.authorization,
      body,
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
    });

    if (!check.ok) {
      /*
       * Assinatura ruim é tentativa de forjar dado de sessão, ou credencial
       * trocada dos dois lados. As duas merecem aparecer no painel — mas a
       * resposta não diz qual das duas foi, para não virar oráculo de
       * afinação para quem estiver tentando.
       */
      await this.log.record({
        level: 'WARN',
        scope: 'livekit',
        event: 'webhook.rejected',
        message: `webhook recusado: ${check.reason}`,
        client: { ip: request.ip, userAgent: request.get('user-agent') ?? undefined },
      });
      throw unauthorized('invalid_signature', 'Assinatura inválida.');
    }

    await this.livekit.handle(check.event);
    // 200 sempre que o evento foi aceito, inclusive para os que ignoramos:
    // qualquer outra coisa faz o LiveKit reentregar em laço.
    return { ok: true };
  }

  private async readBody(request: Request): Promise<Buffer> {
    try {
      return await readRawBody(request, MAX_WEBHOOK_BYTES);
    } catch (failure) {
      if (failure instanceof BodyTooLargeError) {
        throw badRequest('body_too_large', 'Evento grande demais.');
      }
      if (failure instanceof RawBodyUnavailableError) {
        /*
         * Os bytes crus sumiram antes de chegarem aqui, então não há o que
         * conferir. Recusar é a única saída: aceitar sem verificar deixaria
         * qualquer pessoa escrever na tabela que alimenta o painel.
         */
        throw badRequest(
          'raw_body_unavailable',
          'O corpo do evento não chegou íntegro e a assinatura não pôde ser conferida.',
        );
      }
      throw failure;
    }
  }
}
