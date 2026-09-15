import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type {
  LiveRoom,
  MediasoupBroadcastPollResult,
  MediasoupClientConfig,
  MediasoupConnectTransportBody,
  MediasoupConsumeBody,
  MediasoupConsumeResult,
  MediasoupCreateTransportBody,
  MediasoupProduceBody,
  MediasoupProduceResult,
  MediasoupTransportInfo,
} from '@telecord/shared';
import { OptionalAuth, Public } from '../auth/auth.decorators';
import { badRequest } from '../common/errors';
import { MediasoupService } from './mediasoup.service';

/**
 * Proxy do processo mediasoup-sfu — o "control plane" do quinto transporte.
 *
 * Mesmo desenho do `CfsfuController`: o navegador nunca fala com o processo
 * mediasoup direto, só com estas rotas, que confirmam a participação na sala e
 * assinam a chamada ao SFU com o segredo interno. `@OptionalAuth` porque a
 * portaria aqui também é presença na sala, não login.
 */
@Controller('mediasoup')
export class MediasoupController {
  constructor(private readonly mediasoup: MediasoupService) {}

  /**
   * Salas mediasoup com gente dentro AGORA — equivalente público de
   * `GET /api/rooms` (LiveKit), para a Home mostrar o badge de transporte nos
   * cards com contagem viva. Sem paginação, mesmo espírito de `/admin/live`:
   * são poucas salas simultâneas, não milhares.
   */
  @Public()
  @Get('live-rooms')
  liveRooms(): Promise<LiveRoom[]> {
    return this.mediasoup.liveRooms();
  }

  @OptionalAuth()
  @Get('rooms/:roomSlug/config')
  config(@Param('roomSlug') roomSlug: string): Promise<MediasoupClientConfig> {
    return this.mediasoup.clientConfig(requireSlug(roomSlug));
  }

  @OptionalAuth()
  @Post('rooms/:roomSlug/transports')
  createTransport(
    @Param('roomSlug') roomSlug: string,
    @Body() body: Record<string, unknown>,
  ): Promise<MediasoupTransportInfo> {
    return this.mediasoup.createTransport(requireSlug(roomSlug), parseCreateTransport(body));
  }

  @OptionalAuth()
  @Post('rooms/:roomSlug/transports/:transportId/connect')
  async connectTransport(
    @Param('roomSlug') roomSlug: string,
    @Param('transportId') transportId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<{ ok: true }> {
    await this.mediasoup.connectTransport(
      requireSlug(roomSlug),
      requireText(transportId, 'transportId'),
      parseConnectTransport(body),
    );
    return { ok: true };
  }

  @OptionalAuth()
  @Post('rooms/:roomSlug/transports/:transportId/produce')
  produce(
    @Param('roomSlug') roomSlug: string,
    @Param('transportId') transportId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<MediasoupProduceResult> {
    return this.mediasoup.produce(
      requireSlug(roomSlug),
      requireText(transportId, 'transportId'),
      parseProduce(body),
    );
  }

  @OptionalAuth()
  @Post('rooms/:roomSlug/transports/:transportId/consume')
  consume(
    @Param('roomSlug') roomSlug: string,
    @Param('transportId') transportId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<MediasoupConsumeResult> {
    return this.mediasoup.consume(
      requireSlug(roomSlug),
      requireText(transportId, 'transportId'),
      parseConsume(body),
    );
  }

  @OptionalAuth()
  @Post('rooms/:roomSlug/consumers/:consumerId/resume')
  async resumeConsumer(
    @Param('roomSlug') roomSlug: string,
    @Param('consumerId') consumerId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<{ ok: true }> {
    const peerId = requireText(body.peerId, 'peerId');
    await this.mediasoup.resumeConsumer(requireSlug(roomSlug), consumerId, peerId);
    return { ok: true };
  }

  @OptionalAuth()
  @Post('rooms/:roomSlug/leave')
  async leave(
    @Param('roomSlug') roomSlug: string,
    @Body() body: Record<string, unknown>,
  ): Promise<{ ok: true }> {
    const peerId = requireText(body.peerId, 'peerId');
    await this.mediasoup.leave(requireSlug(roomSlug), peerId);
    return { ok: true };
  }

  @OptionalAuth()
  @Post('rooms/:roomSlug/broadcast')
  async sendBroadcast(
    @Param('roomSlug') roomSlug: string,
    @Body() body: Record<string, unknown>,
  ): Promise<{ ok: true }> {
    const peerId = requireText(body.peerId, 'peerId');
    const displayName = requireText(body.displayName, 'displayName');
    const messageBody = typeof body.body === 'string' ? body.body : null;
    if (messageBody === null || messageBody === '') {
      throw badRequest('invalid_request', 'Informe `body`.');
    }
    await this.mediasoup.sendBroadcast(requireSlug(roomSlug), peerId, displayName, messageBody);
    return { ok: true };
  }

  @OptionalAuth()
  @Get('rooms/:roomSlug/broadcast')
  pollBroadcast(
    @Param('roomSlug') roomSlug: string,
    @Query('peerId') peerId: string,
    @Query('since') since: string | undefined,
  ): Promise<MediasoupBroadcastPollResult> {
    return this.mediasoup.pollBroadcast(
      requireSlug(roomSlug),
      requireText(peerId, 'peerId'),
      since === undefined || since === '' ? null : since,
    );
  }
}

// ---------------------------------------------------------------------------
// Validação de entrada
// ---------------------------------------------------------------------------

function requireSlug(roomSlug: string): string {
  return requireText(roomSlug, 'roomSlug');
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest('invalid_request', `Informe \`${field}\`.`);
  }
  return value.trim().slice(0, 128);
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw badRequest('invalid_request', `\`${field}\` precisa ser um objeto.`);
  }
  return value as Record<string, unknown>;
}

function parseCreateTransport(body: Record<string, unknown>): MediasoupCreateTransportBody {
  const peerId = requireText(body.peerId, 'peerId');
  const direction = body.direction === 'send' || body.direction === 'recv' ? body.direction : null;
  if (direction === null) throw badRequest('invalid_request', "`direction` precisa ser 'send' ou 'recv'.");
  return { peerId, direction };
}

function parseConnectTransport(body: Record<string, unknown>): MediasoupConnectTransportBody {
  return {
    peerId: requireText(body.peerId, 'peerId'),
    dtlsParameters: requireObject(body.dtlsParameters, 'dtlsParameters'),
  };
}

function parseProduce(body: Record<string, unknown>): MediasoupProduceBody {
  const kind = body.kind === 'audio' || body.kind === 'video' ? body.kind : null;
  if (kind === null) throw badRequest('invalid_request', "`kind` precisa ser 'audio' ou 'video'.");
  const trackKind = body.trackKind;
  if (
    trackKind !== 'mic' &&
    trackKind !== 'camera' &&
    trackKind !== 'screen-video' &&
    trackKind !== 'screen-audio'
  ) {
    throw badRequest('invalid_request', '`trackKind` desconhecido.');
  }
  return {
    peerId: requireText(body.peerId, 'peerId'),
    kind,
    rtpParameters: requireObject(body.rtpParameters, 'rtpParameters'),
    trackKind,
  };
}

function parseConsume(body: Record<string, unknown>): MediasoupConsumeBody {
  return {
    peerId: requireText(body.peerId, 'peerId'),
    producerId: requireText(body.producerId, 'producerId'),
    rtpCapabilities: requireObject(body.rtpCapabilities, 'rtpCapabilities'),
  };
}
