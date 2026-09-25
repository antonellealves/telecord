import { Injectable } from '@nestjs/common';
import {
  isTilePosition,
  MAX_TILES_SAVED,
  type MediasoupAnnounce,
  type PeerAdminCommand,
  type PeerRoster,
  type TileLayout,
} from '@telecord/shared';
import { Prisma } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Quanto tempo sem renovar presença até alguém ser considerado fora.
 *
 * Generoso de propósito: o cliente renova a cada 5 s, então 20 s tolera três
 * perdas seguidas. Encurtar faria a lista piscar quando a rede engasga.
 */
const PRESENCE_TTL_MS = 20_000;

/**
 * Roster e presença dos pares numa sala.
 *
 * ## O que este serviço NÃO faz
 *
 * Não vê áudio, não vê vídeo, não sabe se a conexão de mídia deu certo. Ele
 * só carrega presença e anúncios opacos de produtores para a UI descobrir
 * quem está na sala e o que puxar.
 */
@Injectable()
export class PeersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Anuncia presença e devolve quem mais está na sala.
   *
   * Uma chamada só faz as duas coisas porque o cliente precisa das duas no
   * mesmo ritmo: quem chegou, quem saiu, e "eu ainda estou aqui". Separar
   * dobraria o número de requisições sem dar nada em troca.
   */
  async heartbeat(
    roomSlug: string,
    peerId: string,
    displayName: string,
    userId: string | null,
    mediasoupAnnounceRaw: unknown = null,
  ): Promise<PeerRoster> {
    const agora = new Date();

    const mediasoup = sanitizarAnuncioMediasoup(mediasoupAnnounceRaw);
    const meta: Prisma.InputJsonValue | typeof Prisma.JsonNull =
      mediasoup === null ? Prisma.JsonNull : ({ mediasoup } as unknown as Prisma.InputJsonValue);

    await this.prisma.peerPresence.upsert({
      where: { roomSlug_peerId: { roomSlug, peerId } },
      create: { roomSlug, peerId, displayName: displayName.slice(0, 64), userId, meta },
      update: { lastSeenAt: agora, displayName: displayName.slice(0, 64), meta },
    });

    const vivos = await this.prisma.peerPresence.findMany({
      where: {
        roomSlug,
        lastSeenAt: { gte: new Date(agora.getTime() - PRESENCE_TTL_MS) },
      },
      select: {
        peerId: true,
        displayName: true,
        userId: true,
        joinedAt: true,
        meta: true,
        adminCommand: true,
      },
      orderBy: [{ joinedAt: 'asc' }, { peerId: 'asc' }],
      /*
       * Teto ALTO, e não limite de produto: a sala aceita quem chegar. Este
       * número existe só para uma sala absurda não devolver uma resposta
       * gigante — não é a regra de quantas pessoas cabem.
       */
      take: 60,
    });

    return {
      peers: vivos.map((p) => {
        const meta = isRecord(p.meta) ? p.meta : null;
        return {
          peerId: p.peerId,
          displayName: p.displayName,
          isAnonymous: p.userId === null,
          joinedAt: p.joinedAt.toISOString(),
          mediasoup: sanitizarAnuncioMediasoup(meta?.mediasoup ?? null),
          adminCommand: sanitizarComandoAdmin(p.adminCommand),
        };
      }),
    };
  }

  /**
   * Grava um comando de moderação para um par específico — só o painel admin
   * chama isto (ver `MediasoupModerationService`). Fica numa coluna separada
   * de `meta` de propósito: `meta` é reescrito pelo PRÓPRIO cliente a cada
   * heartbeat (linha 89 acima), e gravar o comando ali seria apagado no
   * próximo `beat()` antes de o cliente sequer conseguir obedecer.
   */
  async setAdminCommand(roomSlug: string, peerId: string, command: PeerAdminCommand | null): Promise<void> {
    await this.prisma.peerPresence.updateMany({
      where: { roomSlug, peerId },
      data: { adminCommand: command === null ? Prisma.JsonNull : (command as unknown as Prisma.InputJsonValue) },
    });
  }

  async leave(roomSlug: string, peerId: string): Promise<void> {
    // `deleteMany` e não `delete`: sair duas vezes (aba fechando e beforeunload)
    // não pode virar erro.
    await this.prisma.peerPresence.deleteMany({ where: { roomSlug, peerId } });
  }

  /**
   * A arrumação dos quadros deste navegador nesta sala.
   *
   * Vazio quando nunca arrumaram — e vazio é resposta VÁLIDA, não erro: a
   * maioria das salas nunca vai ter arrumação salva, e o cliente cai no
   * layout automático.
   */
  async layout(roomSlug: string, ownerId: string): Promise<TileLayout> {
    const linha = await this.prisma.peerLayout.findUnique({
      where: { roomSlug_ownerId: { roomSlug, ownerId } },
      select: { tiles: true },
    });
    if (linha === null) return {};

    // O que veio do banco é uma coluna JSON: passa pela mesma validação da
    // escrita, porque schema antigo ou linha adulterada não pode quebrar a tela.
    return sanitizar(linha.tiles);
  }

  async saveLayout(roomSlug: string, ownerId: string, tiles: unknown): Promise<void> {
    // O tipo do Prisma para JSON é recursivo e não aceita um Record sem
    // afirmação; o valor já passou por `sanitizar`, que é a garantia que
    // importa. Mesmo tratamento de `log.service.ts`.
    const limpo = sanitizar(tiles) as unknown as Prisma.InputJsonValue;
    await this.prisma.peerLayout.upsert({
      where: { roomSlug_ownerId: { roomSlug, ownerId } },
      create: { roomSlug, ownerId, tiles: limpo },
      update: { tiles: limpo },
    });
  }
}

/**
 * Deixa passar só o que é posição de quadro válida.
 *
 * O corpo vem do cliente e vai para uma coluna JSON, que aceita qualquer
 * coisa — inclusive um megabyte de lixo. O teto de chaves e a checagem por
 * campo são o que impede a tabela de virar depósito.
 */
function sanitizar(valor: unknown): TileLayout {
  if (typeof valor !== 'object' || valor === null) return {};
  const saida: TileLayout = {};
  let contador = 0;
  for (const [peerId, posicao] of Object.entries(valor as Record<string, unknown>)) {
    if (contador >= MAX_TILES_SAVED) break;
    if (peerId.length > 64) continue;
    if (!isTilePosition(posicao)) continue;
    saida[peerId] = {
      x: clamp(posicao.x),
      y: clamp(posicao.y),
      w: clamp(posicao.w),
      h: clamp(posicao.h),
    };
    contador += 1;
  }
  return saida;
}

/** Fora de 0..1 é quadro fora da tela; prender é melhor que recusar. */
function clamp(valor: number): number {
  return Math.max(0, Math.min(1, valor));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Deixa passar só o que é comando de admin válido — mesma cautela dos outros
 * sanitizadores, mas a coluna aqui é escrita pelo SERVIDOR, não pelo
 * navegador; a validação é para uma linha corrompida por um schema antigo não
 * quebrar o heartbeat de todo mundo, não para desconfiar de um cliente hostil.
 */
function sanitizarComandoAdmin(valor: unknown): PeerAdminCommand | null {
  if (!isRecord(valor)) return null;
  const forceMuted = typeof valor.forceMuted === 'boolean' ? valor.forceMuted : undefined;
  const moveTo =
    valor.moveTo === null
      ? null
      : typeof valor.moveTo === 'string' && valor.moveTo !== ''
        ? valor.moveTo.slice(0, 64)
        : undefined;
  if (forceMuted === undefined && moveTo === undefined) return null;
  return { forceMuted, moveTo };
}

/**
 * Deixa passar só o que é anúncio de mediasoup válido.
 *
 * O mediasoup não tem `sessionId` próprio (o `peerId` do telecord já
 * identifica o par), só a lista de `producerId`s publicados.
 */
function sanitizarAnuncioMediasoup(valor: unknown): MediasoupAnnounce | null {
  if (!isRecord(valor)) return null;
  if (!Array.isArray(valor.tracks)) return null;

  const tracks = valor.tracks
    .slice(0, 8)
    .map((raw) => {
      if (!isRecord(raw)) return null;
      const producerId = typeof raw.producerId === 'string' ? raw.producerId.slice(0, 128) : null;
      const kind = raw.kind === 'audio' || raw.kind === 'video' ? raw.kind : null;
      const trackKind =
        raw.trackKind === 'mic' ||
        raw.trackKind === 'camera' ||
        raw.trackKind === 'screen-video' ||
        raw.trackKind === 'screen-audio'
          ? raw.trackKind
          : null;
      if (producerId === null || producerId === '' || kind === null || trackKind === null) return null;
      return { producerId, kind, trackKind };
    })
    .filter((t): t is MediasoupAnnounce['tracks'][number] => t !== null);

  if (tracks.length === 0) return null;
  return { tracks };
}
