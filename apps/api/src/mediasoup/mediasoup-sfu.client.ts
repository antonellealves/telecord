import { Inject, Injectable } from '@nestjs/common';
import type {
  MediasoupConnectTransportBody,
  MediasoupConsumeBody,
  MediasoupConsumeResult,
  MediasoupCreateTransportBody,
  MediasoupProduceBody,
  MediasoupProduceResult,
  MediasoupTransportInfo,
} from '@telecord/shared';
import { CONFIG, type AppConfig, type MediasoupConfig } from '../common/config';
import { serviceUnavailable } from '../common/errors';
import { pickNode } from './node-ring';

const TIMEOUT_MS = 5_000;

/**
 * Por quanto tempo uma instância lembra em que nó pôs uma sala. Curto de
 * propósito: serve para uma rajada de chamadas da MESMA entrada não repetir
 * a consulta a todos os nós, não para guardar a decisão — uma sala que
 * esvaziou e renasceu pode legitimamente morar em outro lugar.
 */
const ASSIGNMENT_TTL_MS = 5_000;

export interface LiveRoomPresence {
  slug: string;
  participants: number;
  earliestJoinedAt: string;
  /** URL do nó onde a sala está. */
  node: string;
}

/**
 * Cliente HTTP dos processos mediasoup-sfu.
 *
 * Única porta de saída para eles: o segredo interno nunca sai daqui, e a
 * resposta é validada na borda. Do outro lado está um processo NOSSO, então a
 * autenticação é um bearer simples (`internalSecret`), não a credencial de um
 * terceiro.
 *
 * ## Um nó ou vários
 *
 * Com um nó só (o caso de hoje) toda chamada vai para ele e nada abaixo faz
 * diferença. Com mais de um, cada sala mora em UM deles — ver `node-ring.ts`
 * para a escolha — e é esta classe que garante que todo mundo da mesma sala
 * seja mandado para o mesmo lugar. Acrescentar capacidade passa a ser subir
 * outra máquina e acrescentar a URL dela em `MEDIASOUP_INTERNAL_URL`.
 */
@Injectable()
export class MediasoupSfuClient {
  private readonly config: MediasoupConfig | null;
  private readonly assignments = new Map<string, { node: string; at: number }>();

  constructor(@Inject(CONFIG) appConfig: AppConfig) {
    this.config = appConfig.mediasoup;
  }

  get enabled(): boolean {
    return this.config !== null;
  }

  /**
   * Com mais de um nó, é a API quem diz ao navegador onde a sala mora — a URL
   * fixa do build (`VITE_MEDIASOUP_PUBLIC_URL`) só sabe apontar para um.
   */
  get multiNode(): boolean {
    return (this.config?.nodeUrls.length ?? 0) > 1;
  }

  /**
   * O nó desta sala.
   *
   * Sala que JÁ tem gente fica onde está, mesmo que a conta mande para outro
   * lugar — é o que impede a lista de nós mudar (um nó a mais, um a menos) e
   * rachar ao meio toda sala viva. Só sala vazia é decidida pela conta.
   */
  async nodeFor(roomSlug: string): Promise<string> {
    const { nodeUrls } = this.requireConfig();
    if (nodeUrls.length === 1) return nodeUrls[0]!;

    const cached = this.assignments.get(roomSlug);
    if (cached !== undefined && Date.now() - cached.at < ASSIGNMENT_TTL_MS) return cached.node;

    const path = `/rooms/${encodeURIComponent(roomSlug)}/presence`;
    const occupancy = await Promise.all(
      nodeUrls.map((node) =>
        this.callNode<{ peers: unknown[] }>(node, 'GET', path, undefined).then(
          (result) => (Array.isArray(result.peers) ? result.peers.length : 0),
          // Nó que não respondeu não recebe sala nova.
          () => -1,
        ),
      ),
    );

    let liveNode: string | null = null;
    let liveCount = 0;
    for (const [index, node] of nodeUrls.entries()) {
      if (occupancy[index]! > liveCount) {
        liveCount = occupancy[index]!;
        liveNode = node;
      }
    }

    const reachable = nodeUrls.filter((_node, index) => occupancy[index]! >= 0);
    // Nenhum respondeu: escolhe pela conta assim mesmo, e a chamada de
    // verdade, logo adiante, devolve o 503 com a mensagem certa.
    const node = liveNode ?? pickNode(reachable.length > 0 ? reachable : nodeUrls, roomSlug);

    this.remember(roomSlug, node);
    return node;
  }

  async routerRtpCapabilities(roomSlug: string): Promise<unknown> {
    return this.call(roomSlug, 'GET', `/rooms/${encodeURIComponent(roomSlug)}/rtp-capabilities`, undefined);
  }

  async createTransport(
    roomSlug: string,
    body: MediasoupCreateTransportBody,
  ): Promise<MediasoupTransportInfo> {
    return this.call(roomSlug, 'POST', `/rooms/${encodeURIComponent(roomSlug)}/transports`, body);
  }

  async connectTransport(
    roomSlug: string,
    transportId: string,
    body: MediasoupConnectTransportBody,
  ): Promise<void> {
    await this.call(
      roomSlug,
      'POST',
      `/rooms/${encodeURIComponent(roomSlug)}/transports/${encodeURIComponent(transportId)}/connect`,
      body,
    );
  }

  async produce(
    roomSlug: string,
    transportId: string,
    body: MediasoupProduceBody,
  ): Promise<MediasoupProduceResult> {
    return this.call(
      roomSlug,
      'POST',
      `/rooms/${encodeURIComponent(roomSlug)}/transports/${encodeURIComponent(transportId)}/produce`,
      body,
    );
  }

  async consume(
    roomSlug: string,
    transportId: string,
    body: MediasoupConsumeBody,
  ): Promise<MediasoupConsumeResult> {
    return this.call(
      roomSlug,
      'POST',
      `/rooms/${encodeURIComponent(roomSlug)}/transports/${encodeURIComponent(transportId)}/consume`,
      body,
    );
  }

  async resumeConsumer(roomSlug: string, consumerId: string, peerId: string): Promise<void> {
    await this.call(
      roomSlug,
      'POST',
      `/rooms/${encodeURIComponent(roomSlug)}/consumers/${encodeURIComponent(consumerId)}?action=resume`,
      { peerId },
    );
  }

  async publishedTracks(roomSlug: string, peerId: string): Promise<unknown> {
    return this.call(
      roomSlug,
      'GET',
      `/rooms/${encodeURIComponent(roomSlug)}/published?peerId=${encodeURIComponent(peerId)}`,
      undefined,
    );
  }

  /**
   * Tira o par da sala no SFU.
   *
   * `kicked` é a moderação removendo alguém: o SFU fecha os canais dele com
   * um código que proíbe reconectar. Sem isso o cliente — que agora volta
   * sozinho de uma queda — desfaria a remoção em dois segundos.
   */
  async leave(roomSlug: string, peerId: string, kicked = false): Promise<void> {
    await this.call(roomSlug, 'POST', `/rooms/${encodeURIComponent(roomSlug)}/leave`, {
      peerId,
      ...(kicked ? { kicked: true } : {}),
    });
  }

  /**
   * Empurra mute/move para UM peer ao vivo pelo socket de presença — ver
   * `pushModerationCommand` em `apps/mediasoup-sfu/src/presence.ts`.
   * Best-effort: quem chama (`MediasoupModerationService`) já escreveu o
   * comando em `PeerPresence.adminCommand` ANTES desta chamada, que
   * continua sendo a fonte de verdade (ex.: alguém que reconectar lê de lá).
   * Isto só acelera quem já está com o socket aberto agora — por isso o erro
   * aqui não deveria derrubar a ação de moderação, só a entrega imediata.
   */
  async pushCommand(
    roomSlug: string,
    peerId: string,
    command: { forceMuted?: boolean; moveTo?: string | null },
  ): Promise<void> {
    await this.call(
      roomSlug,
      'POST',
      `/rooms/${encodeURIComponent(roomSlug)}/peers/${encodeURIComponent(peerId)}/command`,
      command,
    );
  }

  /** Quem está na sala agora, direto da memória do SFU — ver `RoomRegistry.listPresence`. Usado por `MediasoupModerationService.liveParticipants`. */
  async roomPresence(roomSlug: string): Promise<{ peerId: string; displayName: string; joinedAt: string }[]> {
    const result = await this.call<{ peers: { peerId: string; displayName: string; joinedAt: string }[] }>(
      roomSlug,
      'GET',
      `/rooms/${encodeURIComponent(roomSlug)}/presence`,
      undefined,
    );
    return result.peers;
  }

  /**
   * Agregado de todas as salas com presença, de todos os nós — usado por
   * `MediasoupService.liveRooms`.
   *
   * Um nó fora do ar não esconde as salas dos outros; só quando NENHUM
   * responde é que isto vira erro, como já era com um nó só.
   */
  async liveRoomsPresence(): Promise<LiveRoomPresence[]> {
    const { nodeUrls } = this.requireConfig();
    type Rooms = { rooms: { slug: string; participants: number; earliestJoinedAt: string }[] };
    const results = await Promise.allSettled(
      nodeUrls.map((node) => this.callNode<Rooms>(node, 'GET', '/rooms/presence', undefined)),
    );

    const bySlug = new Map<string, LiveRoomPresence>();
    let answered = 0;
    let failure: unknown = undefined;
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        failure = result.reason;
        continue;
      }
      answered += 1;
      for (const room of result.value.rooms) {
        const seen = bySlug.get(room.slug);
        // A mesma sala em dois nós só acontece se ela rachou; mostra o lado
        // onde está a maioria, que é também para onde `nodeFor` manda.
        if (seen === undefined || room.participants > seen.participants) {
          bySlug.set(room.slug, { ...room, node: nodeUrls[index]! });
        }
      }
    }

    if (answered === 0) throw failure;
    return [...bySlug.values()];
  }

  private remember(roomSlug: string, node: string): void {
    const now = Date.now();
    // A instância serverless vive pouco, mas não tão pouco que o mapa possa
    // crescer com toda sala que já passou por ela.
    if (this.assignments.size > 500) {
      for (const [slug, entry] of this.assignments) {
        if (now - entry.at >= ASSIGNMENT_TTL_MS) this.assignments.delete(slug);
      }
    }
    this.assignments.set(roomSlug, { node, at: now });
  }

  private requireConfig(): MediasoupConfig {
    if (this.config === null) {
      throw serviceUnavailable(
        'mediasoup_desligado',
        'A opção mediasoup não está configurada neste servidor.',
      );
    }
    return this.config;
  }

  private async call<T>(
    roomSlug: string,
    method: 'GET' | 'POST',
    path: string,
    body: object | undefined,
  ): Promise<T> {
    return this.callNode<T>(await this.nodeFor(roomSlug), method, path, body);
  }

  private async callNode<T>(
    nodeUrl: string,
    method: 'GET' | 'POST',
    path: string,
    body: object | undefined,
  ): Promise<T> {
    const config = this.requireConfig();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${nodeUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.internalSecret}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      throw serviceUnavailable('mediasoup_indisponivel', 'O servidor mediasoup não respondeu a tempo.');
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw serviceUnavailable('mediasoup_erro', `O servidor mediasoup respondeu ${response.status}.`);
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw serviceUnavailable('mediasoup_resposta', 'Resposta ilegível do servidor mediasoup.');
    }
  }
}
