import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import type {
  CfCloseBody,
  CfRenegotiateBody,
  CfSdp,
  CfSessionResult,
  CfSfuClientConfig,
  CfSfuUsage,
  CfSimpleResult,
  CfTracksBody,
  CfTracksResult,
  CfTrackRequest,
} from '@telecord/shared';
import { OptionalAuth, Roles } from '../auth/auth.decorators';
import { badRequest } from '../common/errors';
import { CfsfuService } from './cfsfu.service';
import { isSdp } from './cloudflare-realtime.client';

/**
 * Proxy do Cloudflare Realtime SFU — o "control plane" do transporte Edge global.
 *
 * O `appToken` vive só no servidor, então o navegador nunca fala com o SFU
 * direto: ele chama estas rotas, que validam a participação na sala e assinam a
 * chamada à Cloudflare. Nenhuma monta HTTP para a Cloudflare aqui — isso é do
 * `CloudflareRealtimeClient`, atrás do `CfsfuService`.
 *
 * `@OptionalAuth` como o resto do modo direto: entrar não exige conta, e a
 * portaria é a presença na sala, não o login.
 */
@Controller('cfsfu')
export class CfsfuController {
  constructor(private readonly cfsfu: CfsfuService) {}

  @OptionalAuth()
  @Get('config')
  config(): Promise<CfSfuClientConfig> {
    return this.cfsfu.clientConfig();
  }

  @OptionalAuth()
  @Post('sessions')
  createSession(@Body() body: Record<string, unknown>): Promise<CfSessionResult> {
    const { roomSlug, peerId } = requireMembership(body);
    return this.cfsfu.createSession(roomSlug, peerId);
  }

  @OptionalAuth()
  @Post('sessions/:sessionId/tracks')
  newTracks(
    @Param('sessionId') sessionId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<CfTracksResult> {
    const { roomSlug, peerId } = requireMembership(body);
    return this.cfsfu.newTracks(roomSlug, peerId, sessionId, parseTracksBody(body));
  }

  @OptionalAuth()
  @Put('sessions/:sessionId/renegotiate')
  renegotiate(
    @Param('sessionId') sessionId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<CfSimpleResult> {
    const { roomSlug, peerId } = requireMembership(body);
    return this.cfsfu.renegotiate(roomSlug, peerId, sessionId, parseRenegotiate(body));
  }

  @OptionalAuth()
  @Put('sessions/:sessionId/tracks/close')
  closeTracks(
    @Param('sessionId') sessionId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<CfTracksResult> {
    const { roomSlug, peerId } = requireMembership(body);
    return this.cfsfu.closeTracks(roomSlug, peerId, sessionId, parseCloseBody(body));
  }

  @OptionalAuth()
  @Post('usage/report')
  async reportUsage(@Body() body: Record<string, unknown>): Promise<{ ok: true }> {
    const { roomSlug, peerId } = requireMembership(body);
    const bytes = typeof body.bytes === 'number' ? body.bytes : 0;
    await this.cfsfu.reportUsage(roomSlug, peerId, bytes);
    return { ok: true };
  }

  /** Acumulado do mês, para o painel. Só administrador. */
  @Roles('ADMIN')
  @Get('usage')
  usage(): Promise<CfSfuUsage> {
    return this.cfsfu.usage();
  }
}

// ---------------------------------------------------------------------------
// Validação de entrada (borda: o corpo do cliente vira tipo concreto aqui)
// ---------------------------------------------------------------------------

function readText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

function requireMembership(body: Record<string, unknown>): { roomSlug: string; peerId: string } {
  const roomSlug = readText(body.roomSlug, 64);
  const peerId = readText(body.peerId, 64);
  if (roomSlug === null || peerId === null) {
    throw badRequest('invalid_request', 'Informe `roomSlug` e `peerId`.');
  }
  return { roomSlug, peerId };
}

function parseSdp(value: unknown): CfSdp {
  if (!isSdp(value)) {
    throw badRequest('invalid_request', 'sessionDescription inválida.');
  }
  return value;
}

function parseTracks(value: unknown): CfTrackRequest[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw badRequest('invalid_request', 'Informe de 1 a 64 tracks.');
  }
  return value.map((raw) => {
    if (typeof raw !== 'object' || raw === null) {
      throw badRequest('invalid_request', 'Track malformada.');
    }
    const track = raw as Record<string, unknown>;
    const trackName = readText(track.trackName, 128);
    if (trackName === null) throw badRequest('invalid_request', 'Track sem `trackName`.');
    if (track.location === 'local') {
      const mid = readText(track.mid, 16);
      if (mid === null) throw badRequest('invalid_request', 'Track local sem `mid`.');
      return { location: 'local', mid, trackName };
    }
    if (track.location === 'remote') {
      const sessionId = readText(track.sessionId, 128);
      if (sessionId === null) throw badRequest('invalid_request', 'Track remota sem `sessionId`.');
      return { location: 'remote', sessionId, trackName };
    }
    throw badRequest('invalid_request', 'Track com `location` desconhecido.');
  });
}

function parseTracksBody(body: Record<string, unknown>): CfTracksBody {
  const tracks = parseTracks(body.tracks);
  // sessionDescription é opcional: o pull de tracks remotas pode vir sem offer.
  if (body.sessionDescription === undefined) {
    return { tracks };
  }
  return { sessionDescription: parseSdp(body.sessionDescription), tracks };
}

function parseRenegotiate(body: Record<string, unknown>): CfRenegotiateBody {
  return { sessionDescription: parseSdp(body.sessionDescription) };
}

function parseCloseBody(body: Record<string, unknown>): CfCloseBody {
  if (!Array.isArray(body.tracks) || body.tracks.length === 0) {
    throw badRequest('invalid_request', 'Informe as tracks a fechar.');
  }
  const tracks = body.tracks.map((raw) => {
    const mid = typeof raw === 'object' && raw !== null ? readText((raw as Record<string, unknown>).mid, 16) : null;
    if (mid === null) throw badRequest('invalid_request', 'Track a fechar sem `mid`.');
    return { mid };
  });
  return {
    tracks,
    sessionDescription: parseSdp(body.sessionDescription),
    force: body.force === true,
  };
}
