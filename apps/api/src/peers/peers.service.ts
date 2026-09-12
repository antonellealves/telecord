import { Injectable } from '@nestjs/common';
import {
  isTilePosition,
  MAX_TILES_SAVED,
  type CfSfuAnnounce,
  type PeerInbox,
  type PeerRoster,
  type PeerSignalKind,
  type TileLayout,
} from '@telecord/shared';
import { Prisma } from '../generated/prisma';
import { badRequest } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Quanto tempo sem renovar presença até alguém ser considerado fora.
 *
 * Generoso de propósito: o cliente renova a cada 5 s, então 20 s tolera três
 * perdas seguidas. Encurtar faria a lista piscar quando a rede engasga, e a
 * lista piscando derruba conexão P2P que estava boa.
 */
const PRESENCE_TTL_MS = 20_000;

/** Sinal não lido vira lixo depois disso. A negociação já falhou ou acabou. */
const SIGNAL_TTL_MS = 60_000;

/** Teto por envelope. SDP real fica na casa dos 4-8 KB; 64 KB é folga larga. */
const MAX_PAYLOAD = 64 * 1024;

const KINDS: PeerSignalKind[] = ['offer', 'answer', 'ice'];

/**
 * Sinalização do modo P2P, por caixa-de-correio.
 *
 * ## O que este serviço NÃO faz
 *
 * Não vê áudio, não vê vídeo, não sabe se a conexão deu certo. Ele carrega
 * envelopes opacos entre dois navegadores até que eles consigam falar direto —
 * e a partir daí fica de fora do caminho. Se este serviço cair depois do
 * aperto de mão, as conversas em curso continuam.
 *
 * ## Por que polling e não socket
 *
 * Não há processo vivo numa função serverless para segurar um socket, e
 * manter um serviço de socket só para isso contraria a razão de o modo P2P
 * existir (ver PLANO/SPEC). O custo é latência de conexão — um ou dois
 * segundos a mais —, pago uma vez por par.
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
    announceRaw: unknown = null,
  ): Promise<PeerRoster> {
    const agora = new Date();

    // O anúncio (sessionId/trackName do cfsfu) vem do cliente e vai para uma
    // coluna JSON: passa pela validação de forma, e o que não for anúncio
    // válido vira nulo em vez de sujar a coluna.
    const announce = sanitizarAnuncio(announceRaw);
    const meta = announce === null ? Prisma.JsonNull : (announce as unknown as Prisma.InputJsonValue);

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
      select: { peerId: true, displayName: true, userId: true, joinedAt: true, meta: true },
      orderBy: [{ joinedAt: 'asc' }, { peerId: 'asc' }],
      /*
       * Teto ALTO, e não limite de produto: a sala aceita quem chegar, e quem
       * decide se a malha aguenta é quem está nela. Este número existe só
       * para uma sala absurda não devolver uma resposta gigante — não é a
       * regra de quantas pessoas cabem.
       */
      take: 60,
    });

    return {
      peers: vivos.map((p) => ({
        peerId: p.peerId,
        displayName: p.displayName,
        isAnonymous: p.userId === null,
        joinedAt: p.joinedAt.toISOString(),
        cfsfu: sanitizarAnuncio(p.meta),
      })),
    };
  }

  async leave(roomSlug: string, peerId: string): Promise<void> {
    // `deleteMany` e não `delete`: sair duas vezes (aba fechando e beforeunload)
    // não pode virar erro.
    await this.prisma.peerPresence.deleteMany({ where: { roomSlug, peerId } });
    await this.prisma.peerSignal.deleteMany({
      where: { roomSlug, OR: [{ fromPeer: peerId }, { toPeer: peerId }] },
    });
  }

  async send(
    roomSlug: string,
    fromPeer: string,
    toPeer: string,
    kind: string,
    payload: string,
  ): Promise<void> {
    const tipo = KINDS.find((k) => k === kind);
    if (tipo === undefined) {
      throw badRequest('sinal_invalido', 'Tipo de sinal desconhecido.');
    }
    if (payload.length > MAX_PAYLOAD) {
      throw badRequest('sinal_grande', 'O sinal passou do tamanho aceito.');
    }
    if (fromPeer === toPeer) {
      throw badRequest('sinal_invalido', 'Um par não sinaliza para si mesmo.');
    }

    await this.prisma.peerSignal.create({
      data: {
        roomSlug,
        fromPeer,
        toPeer,
        kind: tipo,
        payload,
        expiresAt: new Date(Date.now() + SIGNAL_TTL_MS),
      },
    });
  }

  /**
   * Lê e APAGA o que chegou para este par.
   *
   * Apagar na entrega é o ponto: sinal lido duas vezes refaz a negociação e
   * derruba a conexão que acabou de subir. O TTL da tabela é só a rede de
   * segurança para o que nunca foi buscado.
   */
  async inbox(roomSlug: string, peerId: string): Promise<PeerInbox> {
    const cartas = await this.prisma.peerSignal.findMany({
      where: { roomSlug, toPeer: peerId },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });

    if (cartas.length > 0) {
      await this.prisma.peerSignal.deleteMany({
        where: { id: { in: cartas.map((c) => c.id) } },
      });
    }

    return {
      signals: cartas.map((c) => ({
        fromPeer: c.fromPeer,
        kind: c.kind as PeerSignalKind,
        payload: c.payload,
      })),
    };
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

/**
 * Deixa passar só o que é anúncio de cfsfu válido.
 *
 * Vem do cliente e vai para uma coluna JSON; o teto de tracks e a checagem por
 * campo impedem a coluna de virar depósito. Qualquer coisa fora da forma vira
 * `null` — que é o estado normal nos modos que não usam o SFU.
 */
function sanitizarAnuncio(valor: unknown): CfSfuAnnounce | null {
  if (typeof valor !== 'object' || valor === null) return null;
  const bruto = valor as Record<string, unknown>;
  const sessionId = typeof bruto.sessionId === 'string' ? bruto.sessionId.slice(0, 128) : null;
  if (sessionId === null || sessionId === '') return null;
  if (!Array.isArray(bruto.tracks)) return null;

  const tracks = bruto.tracks
    .slice(0, 8)
    .map((raw) => {
      if (typeof raw !== 'object' || raw === null) return null;
      const t = raw as Record<string, unknown>;
      const kind = t.kind === 'audio' || t.kind === 'video' ? t.kind : null;
      const trackName = typeof t.trackName === 'string' ? t.trackName.slice(0, 128) : null;
      const label = typeof t.label === 'string' ? t.label.slice(0, 64) : null;
      if (kind === null || trackName === null || trackName === '' || label === null) return null;
      return { kind, trackName, label };
    })
    .filter((t): t is CfSfuAnnounce['tracks'][number] => t !== null);

  return { sessionId, tracks };
}
