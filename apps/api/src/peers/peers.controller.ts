import { Body, Controller, Param, Post } from '@nestjs/common';
import type { PeerRoster, TileLayout } from '@telecord/shared';
import { OptionalAuth } from '../auth/auth.decorators';
import { CurrentUser } from '../auth/auth.decorators';
import type { AccessClaims } from '../auth/tokens';
import { badRequest } from '../common/errors';
import { PeersService } from './peers.service';

/**
 * Presença/roster dos pares numa sala.
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
    // `mediasoup` é opaco aqui: o serviço valida a forma antes de gravar.
    return this.peers.heartbeat(
      slug,
      peerId,
      displayName,
      claims?.sub ?? null,
      body.mediasoup,
    );
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

  /*
   * Arrumação dos quadros. É de QUEM OLHA: arrastar o quadro de alguém muda a
   * sua tela, não a dos outros — por isso a chave é o próprio peerId.
   */
  @OptionalAuth()
  @Post(':slug/layout')
  async readLayout(
    @Param('slug') slug: string,
    @Body() body: Record<string, unknown>,
  ): Promise<{ tiles: TileLayout }> {
    const peerId = readText(body.peerId, 64);
    if (peerId === null) {
      throw badRequest('invalid_request', 'Informe o `peerId`.');
    }
    return { tiles: await this.peers.layout(slug, peerId) };
  }

  @OptionalAuth()
  @Post(':slug/layout/save')
  async saveLayout(
    @Param('slug') slug: string,
    @Body() body: Record<string, unknown>,
  ): Promise<{ ok: true }> {
    const peerId = readText(body.peerId, 64);
    if (peerId === null) {
      throw badRequest('invalid_request', 'Informe o `peerId`.');
    }
    await this.peers.saveLayout(slug, peerId, body.tiles);
    return { ok: true };
  }
}

function readText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}
