import { Inject, Injectable } from '@nestjs/common';
import { RoomServiceClient } from 'livekit-server-sdk';
import { LIVEKIT_HOST, type LiveParticipant, type LiveRoom } from '@telecord/shared';
import { CONFIG, type AppConfig } from '../common/config';
import { badRequest, serviceUnavailable } from '../common/errors';
import { LogService } from '../logging/log.service';
import type { LogClient } from '../logging/log.service';
import type { Actor } from '../rooms/rooms.service';

/**
 * Poderes de moderação sobre a sala VIVA.
 *
 * ## Por que isto fala com o SFU, e não com o banco
 *
 * Sala no banco é a ficha: nome, dono, sons. Quem está falando AGORA só o
 * LiveKit sabe, porque é ele que mantém a conexão. Mutar alguém gravando uma
 * coluna não calaria ninguém — o áudio continua subindo do navegador para o
 * SFU e de lá para todo mundo. Só o `RoomServiceClient` interrompe de verdade.
 *
 * ## O que cada poder faz, e o que NÃO faz
 *
 * - `mute` silencia a track publicada. É aplicado no servidor, então não
 *   depende de o cliente cooperar. A pessoa vê o próprio microfone mudo e pode
 *   religá-lo — isto é interromper quem está atrapalhando, não uma mordaça.
 *   Mordaça de verdade exigiria retirar o grant `canPublish` do token, o que
 *   só vale no próximo join.
 * - `move` desconecta e o cliente reconecta na sala nova. NÃO existe "mover"
 *   no protocolo: o front escuta o motivo da desconexão e entra no destino.
 * - `remove` desconecta. Também não é banimento: quem tem a URL entra de novo,
 *   porque entrar não depende de conta (PLANO.md §0). Para impedir a volta, o
 *   caminho é suspender a CONTA, que já existe em `/admin/users/:id`.
 *
 * Nenhum poder é silencioso: todos passam por `log.audit`, com antes e depois.
 */
@Injectable()
export class ModerationService {
  private client: RoomServiceClient | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly log: LogService,
  ) {}

  /**
   * Cliente do SFU, criado na primeira vez que alguém usa.
   *
   * Preguiçoso porque as credenciais do LiveKit são OPCIONAIS na configuração
   * (o serviço sobe sem elas), e construir no boot faria o painel inteiro
   * depender de algo que só a moderação usa.
   */
  private sfu(): RoomServiceClient {
    if (this.config.livekit === null) {
      throw serviceUnavailable(
        'livekit_nao_configurado',
        'Sem LIVEKIT_API_KEY e LIVEKIT_API_SECRET não dá para moderar a sala ao vivo.',
      );
    }
    this.client ??= new RoomServiceClient(
      `https://${LIVEKIT_HOST}`,
      this.config.livekit.apiKey,
      this.config.livekit.apiSecret,
    );
    return this.client;
  }

  /** Salas com gente dentro, agora, direto do SFU. */
  async liveRooms(): Promise<LiveRoom[]> {
    const rooms = await this.sfu().listRooms();
    const out: LiveRoom[] = [];
    for (const room of rooms) {
      out.push({
        slug: room.name,
        participants: room.numParticipants,
        createdAt: new Date(Number(room.creationTime) * 1000).toISOString(),
      });
    }
    return out.sort((a, b) => b.participants - a.participants || a.slug.localeCompare(b.slug));
  }

  /** Quem está numa sala agora, com o estado de cada track. */
  async liveParticipants(slug: string): Promise<LiveParticipant[]> {
    const people = await this.sfu().listParticipants(slug);
    return people.map((p) => ({
      identity: p.identity,
      displayName: p.name && p.name.length > 0 ? p.name : p.identity,
      joinedAt: new Date(Number(p.joinedAt) * 1000).toISOString(),
      /*
       * `identity` é o id da conta para quem entrou logado, e um UUID sorteado
       * para quem entrou anônimo (ver `api/token.ts`). O painel usa isso para
       * saber em quem dá para agir na CONTA, e em quem só dá para agir na sala.
       */
      isAnonymous: !/^c[a-z0-9]{20,}$/.test(p.identity),
      tracks: p.tracks.map((t) => ({
        sid: t.sid,
        source: String(t.source),
        muted: t.muted,
      })),
    }));
  }

  async muteParticipant(
    slug: string,
    identity: string,
    muted: boolean,
    actor: Actor,
    client: LogClient | undefined,
  ): Promise<void> {
    const people = await this.sfu().listParticipants(slug);
    const target = people.find((p) => p.identity === identity);
    if (target === undefined) {
      throw badRequest('participante_ausente', 'Essa pessoa não está mais na sala.');
    }

    /*
     * Só o microfone. Mutar a tela ou a câmera junto seria uma decisão a mais
     * escondida num botão que diz "mutar" — e quem quer cortar a tela de
     * alguém tem o botão de remover.
     */
    const mic = target.tracks.find((t) => String(t.source) === 'MICROPHONE' || t.source === 2);
    if (mic === undefined) {
      throw badRequest('sem_microfone', 'Essa pessoa não está publicando áudio.');
    }

    await this.sfu().mutePublishedTrack(slug, identity, mic.sid, muted);

    await this.log.audit({
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: muted ? 'moderacao.mutar' : 'moderacao.desmutar',
      targetType: 'participante',
      targetId: `${slug}/${identity}`,
      summary: `${muted ? 'Mutou' : 'Desmutou'} ${target.name || identity} em ${slug}`,
      before: { muted: mic.muted },
      after: { muted },
      client,
    });
  }

  /**
   * Move alguém para outra sala.
   *
   * O protocolo do LiveKit não tem "mover": o que existe é desconectar. O
   * cliente recebe o motivo junto com os metadados e entra sozinho no destino
   * — por isso o destino é gravado em `metadata` ANTES da desconexão, que é a
   * única informação que sobrevive ao corte.
   */
  async moveParticipant(
    slug: string,
    identity: string,
    destino: string,
    actor: Actor,
    client: LogClient | undefined,
  ): Promise<void> {
    if (destino.trim() === '' || destino === slug) {
      throw badRequest('destino_invalido', 'Escolha uma sala diferente da atual.');
    }

    const people = await this.sfu().listParticipants(slug);
    const target = people.find((p) => p.identity === identity);
    if (target === undefined) {
      throw badRequest('participante_ausente', 'Essa pessoa não está mais na sala.');
    }

    await this.sfu().updateParticipant(slug, identity, {
      metadata: JSON.stringify({ moverPara: destino, em: new Date().toISOString() }),
    });
    await this.sfu().removeParticipant(slug, identity);

    await this.log.audit({
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: 'moderacao.mover',
      targetType: 'participante',
      targetId: `${slug}/${identity}`,
      summary: `Moveu ${target.name || identity} de ${slug} para ${destino}`,
      before: { sala: slug },
      after: { sala: destino },
      client,
    });
  }

  async removeParticipant(
    slug: string,
    identity: string,
    actor: Actor,
    client: LogClient | undefined,
  ): Promise<void> {
    const people = await this.sfu().listParticipants(slug);
    const target = people.find((p) => p.identity === identity);
    if (target === undefined) {
      throw badRequest('participante_ausente', 'Essa pessoa não está mais na sala.');
    }

    await this.sfu().removeParticipant(slug, identity);

    await this.log.audit({
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: 'moderacao.remover',
      targetType: 'participante',
      targetId: `${slug}/${identity}`,
      summary: `Removeu ${target.name || identity} de ${slug}`,
      before: { sala: slug, presente: true },
      after: { presente: false },
      client,
    });
  }
}
