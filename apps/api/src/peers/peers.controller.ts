import { Body, Controller, Param, Post } from '@nestjs/common';
import type { PeerInbox, PeerRoster } from '@telecord/shared';
import { OptionalAuth } from '../auth/auth.decorators';
import { CurrentUser } from '../auth/auth.decorators';
import type { AccessClaims } from '../auth/tokens';
import { badRequest } from '../common/errors';
import { PeersService } from './peers.service';

/**
 * Sinalização do modo P2P.
 *
 * ## Tudo é POST, inclusive as leituras
 *
 * `inbox` LÊ e APAGA na mesma chamada, então não é idempotente e não pode ser
 * GET — um proxy que cacheie ou repita a requisição comeria sinal de alguém.
 * `heartbeat` também escreve. Fazer os dois POST deixa isso explícito em vez
 * de depender de quem lê o código lembrar.
 *
 * ## Por que `OptionalAuth`
 *
 * Entrar numa sala não exige conta (PLANO.md §0), e isso não muda por causa do
 * modo de transmissão. Quem está logado tem o id da conta como `peerId` e
 * aparece sem a marca de anônimo; quem não está usa o UUID que o próprio
 * navegador sorteou, igual ao modo LiveKit.
 */
@Controller('peers')
export class PeersController {
  constructor(private readonly peers: PeersService) {}

  @OptionalAuth()
  @Post(':slug/heartbeat')
  async heartbeat(
    @Param('slug') slug: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() claims: AccessClaims | undefined,
  ): Promise<PeerRoster> {
    const peerId = readText(body.peerId, 64);
    if (peerId === null) {
      throw badRequest('invalid_request', 'Informe o `peerId`.');
    }
    const displayName = readText(body.displayName, 64) ?? 'Alguém';
    return this.peers.heartbeat(slug, peerId, displayName, claims?.sub ?? null);
  }

  @OptionalAuth()
  @Post(':slug/leave')
  async leave(
    @Param('slug') slug: string,
    @Body() body: Record<string, unknown>,
  ): Promise<{ ok: true }> {
    const peerId = readText(body.peerId, 64);
    if (peerId === null) {
      throw badRequest('invalid_request', 'Informe o `peerId`.');
    }
    await this.peers.leave(slug, peerId);
    return { ok: true };
  }

  @OptionalAuth()
  @Post(':slug/signal')
  async signal(
    @Param('slug') slug: string,
    @Body() body: Record<string, unknown>,
  ): Promise<{ ok: true }> {
    const fromPeer = readText(body.fromPeer, 64);
    const toPeer = readText(body.toPeer, 64);
    const kind = readText(body.kind, 8);
    const payload = typeof body.payload === 'string' ? body.payload : null;

    if (fromPeer === null || toPeer === null || kind === null || payload === null) {
      throw badRequest('invalid_request', 'Sinal incompleto.');
    }

    await this.peers.send(slug, fromPeer, toPeer, kind, payload);
    return { ok: true };
  }

  @OptionalAuth()
  @Post(':slug/inbox')
  async inbox(
    @Param('slug') slug: string,
    @Body() body: Record<string, unknown>,
  ): Promise<PeerInbox> {
    const peerId = readText(body.peerId, 64);
    if (peerId === null) {
      throw badRequest('invalid_request', 'Informe o `peerId`.');
    }
    return this.peers.inbox(slug, peerId);
  }
}

function readText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}
