import { Injectable } from '@nestjs/common';
import type { PeerInbox, PeerRoster, PeerSignalKind } from '@telecord/shared';
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
  ): Promise<PeerRoster> {
    const agora = new Date();

    await this.prisma.peerPresence.upsert({
      where: { roomSlug_peerId: { roomSlug, peerId } },
      create: { roomSlug, peerId, displayName: displayName.slice(0, 64), userId },
      update: { lastSeenAt: agora, displayName: displayName.slice(0, 64) },
    });

    const vivos = await this.prisma.peerPresence.findMany({
      where: {
        roomSlug,
        lastSeenAt: { gte: new Date(agora.getTime() - PRESENCE_TTL_MS) },
      },
      select: { peerId: true, displayName: true, userId: true, joinedAt: true },
      orderBy: [{ joinedAt: 'asc' }, { peerId: 'asc' }],
      // Teto duro: malha completa cresce ao quadrado, e o cliente também
      // recusa acima disso. Aqui é a segunda tranca, do lado do servidor.
      take: 12,
    });

    return {
      peers: vivos.map((p) => ({
        peerId: p.peerId,
        displayName: p.displayName,
        isAnonymous: p.userId === null,
        joinedAt: p.joinedAt.toISOString(),
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
}
