import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type * as mediasoup from 'mediasoup';
import type { MediasoupTrackKind, SignalSpeaker } from '@telecord/shared';
import { MEDIA_CODECS } from './codecs';
import type { WorkerPool, WorkerSlot } from './workers';

/**
 * Estado ao vivo do SFU: as salas, quem está em cada uma e a mídia que cada
 * par publica e assina. Tudo em memória — de propósito: este processo não é
 * o dono da verdade sobre quem tem permissão de entrar (isso é `apps/api`, que
 * assina o token), só o dono da mídia enquanto ela está fluindo. Reiniciar o
 * processo derruba toda sala ativa; os clientes voltam sozinhos (ver
 * `mediasoupConnection.ts`) e refazem a sessão em segundos.
 *
 * ## Uma sala, um ou mais Workers
 *
 * Sala pequena mora inteira num Router, num Worker só: é o caminho mais
 * curto que um pacote pode fazer, e é o caso que este app existe para servir
 * — pouca gente, qualidade no teto. Quando o Worker enche, quem entra DEPOIS
 * vai para um Router da mesma sala em outro Worker, e as tracks atravessam de
 * um para o outro por uma ponte (`pipeToRouter`) criada na hora em que alguém
 * do outro lado assina. Ninguém é movido, nada é renegociado: a sala só passa
 * a ocupar mais de um núcleo.
 *
 * É o que faz capacidade ser assunto de máquina. O que limita uma sala é a
 * soma dos núcleos do nó, e o que limita o nó é a máquina onde ele roda.
 *
 * ## Presença
 *
 * O registry também é o dono de quem está na sala agora (`displayName`,
 * `joinedAt`), à parte de `peers` (que só existe para quem tem sessão de
 * mídia): uma pessoa pode ter o socket de presença conectado sem nunca ter
 * publicado nada.
 */

/**
 * Peso de cada tipo de track na conta de carga de um Worker.
 *
 * A referência é a regra de bolso do próprio mediasoup — um Worker aguenta
 * por volta de 500 consumers —, que é uma conta de videoconferência comum.
 * Aqui nada é comum: a câmera sobe a 8 Mbps e a tela a até 25 (ver
 * `videoProfile.ts`), várias vezes o bitrate de uma chamada típica, e o que
 * um Worker gasta é proporcional a PACOTE encaminhado, não a track. Contar
 * uma tela como uma unidade faria a conta prometer bem mais gente do que o
 * Worker aguenta.
 *
 * São estimativas, e por isso não mandam sozinhas: a CPU medida do Worker
 * entra na mesma decisão (`WorkerPool.score`) e vence quando discorda.
 */
const LOAD_UNITS: Record<MediasoupTrackKind, number> = {
  mic: 1,
  'screen-audio': 1,
  camera: 5,
  'screen-video': 10,
};

/**
 * Acima disto conta como fala. Abaixo é respiração, teclado e ventilador.
 *
 * -45 dBov é permissivo de propósito: o perfil de voz daqui desliga o
 * controle automático de ganho (ver `audioProfile.ts`), então quem fala baixo
 * CHEGA baixo — com um limiar afinado para voz normalizada essa pessoa nunca
 * acenderia.
 */
const SPEAKING_THRESHOLD_DBOV = -45;

/** Intervalo da medição. 200 ms acende o destaque junto com a primeira sílaba. */
const SPEAKING_INTERVAL_MS = 200;

/** Quantos falantes simultâneos o destaque distingue. Acima disto já é gritaria. */
const SPEAKING_MAX_ENTRIES = 12;

type Router = mediasoup.types.Router;
type WebRtcTransport = mediasoup.types.WebRtcTransport;
type Producer = mediasoup.types.Producer;
type Consumer = mediasoup.types.Consumer;

interface ProducerEntry {
  producer: Producer;
  ownerPeerId: string;
  trackKind: MediasoupTrackKind;
  /** Em qual Router da sala o producer NASCEU — é de lá que sai a ponte para os outros. */
  routerKey: number;
}

interface Peer {
  id: string;
  /** Ver `SignalReady.sessionId`: muda quando a mídia deste par é refeita do zero. */
  sessionId: string;
  routerKey: number;
  transports: { send: WebRtcTransport | null; recv: WebRtcTransport | null };
  producers: Map<string, ProducerEntry>;
  consumers: Map<string, Consumer>;
  rtpCapabilities: mediasoup.types.RtpCapabilities | null;
}

/** O pedaço de uma sala que mora num Worker. */
interface RoomRouter {
  /** O índice do Worker — uma sala tem no máximo um Router por Worker. */
  key: number;
  slot: WorkerSlot;
  router: Router;
  audioLevelObserver: mediasoup.types.AudioLevelObserver;
  peerIds: Set<string>;
  /** `peerId -> dBov` de quem falou no último intervalo, só dos microfones nascidos AQUI. */
  speaking: Map<string, number>;
}

interface Room {
  slug: string;
  routers: Map<number, RoomRouter>;
  /**
   * Criações em andamento. Duas pessoas entrando na mesma sala nova no mesmo
   * instante precisam cair no MESMO Router: sem isto cada uma criava o seu, a
   * segunda sobrescrevia a primeira no mapa e as duas ficavam numa sala de
   * mesmo nome sem nunca se ouvir.
   */
  routerCreations: Map<number, Promise<RoomRouter>>;
  primaryKey: number | null;
  primaryPending: Promise<RoomRouter> | null;
  peers: Map<string, Peer>;
  peerCreations: Map<string, Promise<Peer>>;
  /** Todo producer da sala, de qualquer Router — é por aqui que `consume` acha a origem. */
  producers: Map<string, ProducerEntry>;
  /** Pontes prontas ou em andamento, por `"<Router de destino>:<producerId>"`. */
  pipes: Map<string, Promise<void>>;
  speakers: SignalSpeaker[];
  speakersKey: string;
}

interface PresenceEntry {
  displayName: string;
  joinedAt: number;
}

export interface TrackAnnouncedEvent {
  roomSlug: string;
  peerId: string;
  producerId: string;
  kind: 'audio' | 'video';
  trackKind: MediasoupTrackKind;
}

export interface TrackClosedEvent {
  roomSlug: string;
  peerId: string;
  producerId: string;
}

export interface ConsumerClosedEvent {
  roomSlug: string;
  peerId: string;
  consumerId: string;
  producerId: string;
}

export interface SpeakersEvent {
  roomSlug: string;
  speakers: SignalSpeaker[];
}

/**
 * Por que um par saiu do registry. Quem escuta precisa saber: `kicked` fecha
 * os canais dele com um código que proíbe reconectar — sem isso o cliente
 * voltaria sozinho e a remoção duraria dois segundos.
 */
export type PeerRemovalReason = 'left' | 'timeout' | 'kicked';

export interface PeerRemovedEvent {
  roomSlug: string;
  peerId: string;
  reason: PeerRemovalReason;
}

/** O que o servidor tem de um par, para ele conferir contra o que acha que tem. */
export interface PeerSessionState {
  sessionId: string;
  /** `true` quando a sessão que o cliente conhecia continua valendo. */
  resumed: boolean;
  transportIds: string[];
  producerIds: string[];
  consumerIds: string[];
}

export interface RegistryStats {
  rooms: number;
  peers: number;
  producers: number;
  consumers: number;
  /** Salas que transbordaram para mais de um Worker. */
  roomsSpanningWorkers: number;
}

export interface RegistryOptions {
  /** Onde as pontes entre Workers escutam — sempre local, ver `SfuConfig.pipeMinPort`. */
  pipeListenInfo: mediasoup.types.TransportListenInfo;
}

type RegistryEvents = {
  /** Alguém publicou — o resto da sala assina na hora. */
  'track:announced': [TrackAnnouncedEvent];
  /** A track saiu do ar de vez (parou de publicar, saiu, o transporte caiu). */
  'track:closed': [TrackClosedEvent];
  /** O consumer morreu mas a track continua no ar — ver `SignalEvents['consumer:closed']`. */
  'consumer:closed': [ConsumerClosedEvent];
  speakers: [SpeakersEvent];
  /** O roster desta sala mudou. */
  presence: [roomSlug: string];
  'peer:removed': [PeerRemovedEvent];
};

export class RoomRegistry extends EventEmitter<RegistryEvents> {
  private readonly rooms = new Map<string, Room>();
  /** `roomSlug -> peerId -> presença`, separado de `Room.peers` — ver docstring do topo do arquivo. */
  private readonly presence = new Map<string, Map<string, PresenceEntry>>();

  private constructor(
    private readonly pool: WorkerPool,
    private readonly options: RegistryOptions,
    /**
     * As RTP capabilities de QUALQUER Router deste nó. Dependem só de
     * `MEDIA_CODECS`, então são calculadas uma vez — antes disto a rota que
     * as devolvia criava um Router por sala perguntada, e bastava pedir a
     * configuração de mil salas inventadas para deixar mil Routers vivos
     * para sempre numa VM de meio giga.
     */
    readonly routerRtpCapabilities: mediasoup.types.RtpCapabilities,
  ) {
    super();
  }

  static async create(pool: WorkerPool, options: RegistryOptions): Promise<RoomRegistry> {
    const probe = await pool.slots[0]!.worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    const capabilities = probe.rtpCapabilities;
    probe.close();
    return new RoomRegistry(pool, options, capabilities);
  }

  // -------------------------------------------------------------------------
  // Sessão de mídia
  // -------------------------------------------------------------------------

  /**
   * Entrada pelo canal de mídia: garante que o par existe na sala e decide se
   * a sessão que o cliente conhecia continua valendo.
   *
   * Sem `knownSessionId` igual ao daqui, tudo o que este par tinha é fechado
   * antes de responder. É o caso de recarregar a página ou abrir a sala em
   * outra aba: a mídia antiga pertence a uma página que não existe mais, e
   * deixá-la viva é como a mesma pessoa aparecia compartilhando a tela várias
   * vezes.
   */
  async joinPeer(
    roomSlug: string,
    peerId: string,
    displayName: string,
    knownSessionId: string | null,
  ): Promise<PeerSessionState> {
    const room = this.ensureRoom(roomSlug);
    const peer = await this.ensurePeer(room, peerId);
    const resumed = knownSessionId !== null && knownSessionId === peer.sessionId;
    if (!resumed) this.resetPeerMedia(peer);
    this.setPresence(roomSlug, peerId, displayName);
    return {
      sessionId: peer.sessionId,
      resumed,
      transportIds: [peer.transports.send, peer.transports.recv].flatMap((transport) =>
        transport === null || transport.closed ? [] : [transport.id],
      ),
      producerIds: [...peer.producers.keys()],
      consumerIds: [...peer.consumers.keys()],
    };
  }

  setPeerRtpCapabilities(
    roomSlug: string,
    peerId: string,
    rtpCapabilities: mediasoup.types.RtpCapabilities,
  ): void {
    this.getPeer(this.getRoom(roomSlug), peerId).rtpCapabilities = rtpCapabilities;
  }

  /**
   * Cria um `WebRtcTransport` novo — um para publicar, outro para assinar.
   *
   * Transportes SEPARADOS por direção (em vez de um bidirecional só) é a
   * recomendação do próprio mediasoup: simplifica o ciclo de vida, porque
   * fechar o de assinatura ao sair de uma sala não deveria nunca arriscar
   * cortar o que a pessoa está publicando, e vice-versa.
   */
  async createTransport(
    roomSlug: string,
    peerId: string,
    direction: 'send' | 'recv',
  ): Promise<WebRtcTransport> {
    const room = this.ensureRoom(roomSlug);
    const peer = await this.ensurePeer(room, peerId);
    const sessionId = peer.sessionId;
    const roomRouter = this.routerOf(room, peer);

    const transport = await roomRouter.router.createWebRtcTransport({
      // A porta é a do Worker, dividida por todos — ver `WorkerSlot.webRtcServer`.
      webRtcServer: roomRouter.slot.webRtcServer,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      /*
       * Estimativa INICIAL de banda de saída, não um teto — é de onde o
       * controle de congestionamento (transport-cc/REMB) parte antes de
       * medir a rede de verdade.
       *
       * Começar baixo custa caro nos primeiros segundos: o encoder se
       * acomoda à estimativa conservadora e demora a subir, que é
       * exatamente quando alguém dá "bom dia" e soa comprimido. Com tela em
       * alta (até 25 Mbps, ver `screenQuality`) e voz em 256 kbps
       * (`MIC_TARGET_BITRATE`), 1 Mbps era baixo demais para o ponto de
       * partida. O estimador ainda corrige para baixo sozinho em rede ruim.
       */
      initialAvailableOutgoingBitrate: 6_000_000,
    });

    /*
     * Teto de ENTRADA por transporte, no lado do SFU. Sem isto o mediasoup
     * aplica o default dele e estrangula justamente o que os perfis de
     * áudio/vídeo tentam liberar.
     *
     * 60 Mbps cobre o pior caso somado de UM publicador: tela no nível
     * "máxima" (ver `SCREEN_QUALITY_OPTIONS`) + câmera (8 Mbps) + voz
     * (256 kbps), com folga. Best-effort: versão que não suporte ignora.
     */
    await transport.setMaxIncomingBitrate(60_000_000).catch(() => undefined);

    // O par pode ter saído, ou refeito a sessão, enquanto o Worker respondia.
    if (room.peers.get(peerId) !== peer || peer.sessionId !== sessionId) {
      transport.close();
      throw new NotFoundError('A sessão de mídia mudou antes de o transporte ficar pronto.');
    }

    /*
     * O mesmo `peerId` pode pedir um transporte novo sem o antigo ter
     * fechado. Sem fechar o antigo aqui, ele ficava órfão para sempre —
     * nunca mais referenciado por `peer.transports`, mas com o
     * `WebRtcTransport` e os producers dele vivos no mediasoup, porque só
     * chega a fechar se alguém chamar `.close()` nele.
     */
    const previous = peer.transports[direction];
    if (previous !== null && previous.id !== transport.id) previous.close();
    peer.transports[direction] = transport;

    transport.on('dtlsstatechange', (state) => {
      if (state === 'closed') transport.close();
    });
    transport.observer.once('close', () => {
      if (peer.transports[direction] === transport) peer.transports[direction] = null;
    });

    return transport;
  }

  async connectTransport(
    roomSlug: string,
    peerId: string,
    transportId: string,
    dtlsParameters: mediasoup.types.DtlsParameters,
  ): Promise<void> {
    const peer = this.getPeer(this.getRoom(roomSlug), peerId);
    await this.findTransport(peer, transportId).connect({ dtlsParameters });
  }

  /**
   * Credenciais ICE novas para um transporte que perdeu o caminho — a pessoa
   * trocou de rede. O transporte, os producers e os consumers continuam os
   * mesmos; só o caminho até eles é renegociado.
   */
  async restartIce(
    roomSlug: string,
    peerId: string,
    transportId: string,
  ): Promise<mediasoup.types.IceParameters> {
    const peer = this.getPeer(this.getRoom(roomSlug), peerId);
    return this.findTransport(peer, transportId).restartIce();
  }

  async produce(
    roomSlug: string,
    peerId: string,
    transportId: string,
    kind: mediasoup.types.MediaKind,
    rtpParameters: mediasoup.types.RtpParameters,
    trackKind: MediasoupTrackKind,
  ): Promise<Producer> {
    const room = this.getRoom(roomSlug);
    const peer = this.getPeer(room, peerId);
    const transport = this.findTransport(peer, transportId);
    if (peer.transports.send !== transport) {
      throw new BadRequestError('Só o transporte de envio publica.');
    }
    const roomRouter = this.routerOf(room, peer);

    const producer = await transport.produce({ kind, rtpParameters });
    if (producer.closed) {
      throw new NotFoundError('O transporte fechou antes de a track ficar pronta.');
    }

    /*
     * Um producer por tipo de track, por par. O cliente já publica assim; o
     * que esta regra cobre é o que ele deixa para trás quando NÃO avisa que
     * parou — o transporte antigo por HTTP nunca avisou, e cada vez que
     * alguém soltava o "aperte para falar" ficava um producer morto aqui e um
     * consumer morto em cada ouvinte, até a pessoa sair da sala.
     */
    for (const existing of [...peer.producers.values()]) {
      if (existing.trackKind === trackKind) existing.producer.close();
    }

    const entry: ProducerEntry = { producer, ownerPeerId: peerId, trackKind, routerKey: roomRouter.key };
    peer.producers.set(producer.id, entry);
    room.producers.set(producer.id, entry);
    this.account(roomRouter.slot, LOAD_UNITS[trackKind], producer.observer);

    // Só microfone conta como "falando" — o áudio da tela é o filme, não a pessoa.
    if (trackKind === 'mic') {
      void roomRouter.audioLevelObserver.addProducer({ producerId: producer.id }).catch(() => undefined);
    }

    // `observer.close` cobre os dois jeitos de morrer: fechado a pedido
    // (`closeProducer`) e levado junto com o transporte.
    producer.observer.once('close', () => {
      peer.producers.delete(producer.id);
      room.producers.delete(producer.id);
      for (const key of [...room.pipes.keys()]) {
        if (key.endsWith(`:${producer.id}`)) room.pipes.delete(key);
      }
      if (trackKind === 'mic' && roomRouter.speaking.delete(peerId)) this.publishSpeakers(room);
      this.emit('track:closed', { roomSlug, peerId, producerId: producer.id });
    });

    this.emit('track:announced', { roomSlug, peerId, producerId: producer.id, kind: producer.kind, trackKind });

    return producer;
  }

  /** Tira UMA track do ar. Idempotente: fechar o que já fechou não é erro. */
  closeProducer(roomSlug: string, peerId: string, producerId: string): void {
    const peer = this.getPeer(this.getRoom(roomSlug), peerId);
    peer.producers.get(producerId)?.producer.close();
  }

  /**
   * `rtpCapabilities` só vem preenchido pelo caminho HTTP antigo, que manda
   * as do Device a cada chamada; o canal de mídia as registra uma vez
   * (`setPeerRtpCapabilities`).
   */
  async consume(
    roomSlug: string,
    peerId: string,
    transportId: string,
    producerId: string,
    rtpCapabilities?: mediasoup.types.RtpCapabilities,
  ): Promise<Consumer> {
    const room = this.getRoom(roomSlug);
    const peer = this.getPeer(room, peerId);
    const transport = this.findTransport(peer, transportId);
    if (peer.transports.recv !== transport) {
      throw new BadRequestError('Só o transporte de recepção assina.');
    }
    const capabilities = rtpCapabilities ?? peer.rtpCapabilities;
    if (capabilities === null) {
      throw new BadRequestError('Envie as RTP capabilities do Device antes de assinar.');
    }
    const origin = room.producers.get(producerId);
    if (origin === undefined) {
      throw new NotFoundError(`Producer '${producerId}' não existe nesta sala.`);
    }
    const roomRouter = this.routerOf(room, peer);

    // A track nasceu em outro Worker: traz para cá antes de assinar.
    if (origin.routerKey !== roomRouter.key) {
      await this.ensurePiped(room, origin, roomRouter);
    }

    if (!roomRouter.router.canConsume({ producerId, rtpCapabilities: capabilities })) {
      throw new BadRequestError('O Device do assinante não suporta os codecs desta track.');
    }

    // Assinante começa pausado — a UI manda `resume` só depois de o
    // `<audio>`/`<video>` estar pronto para tocar, evitando pacotes
    // descartados antes de haver quem os consuma no navegador.
    const consumer = await transport.consume({
      producerId,
      rtpCapabilities: capabilities,
      paused: true,
    });
    if (consumer.closed) {
      throw new NotFoundError('A track saiu do ar antes de a assinatura ficar pronta.');
    }
    peer.consumers.set(consumer.id, consumer);
    this.account(roomRouter.slot, LOAD_UNITS[origin.trackKind], consumer.observer);

    consumer.observer.once('close', () => {
      peer.consumers.delete(consumer.id);
    });
    consumer.on('producerclose', () => {
      // Se a ORIGEM fechou, `track:closed` já conta a história inteira. Só
      // vale avisar quando a track continua no ar e o que caiu foi a ponte.
      if (origin.producer.closed) return;
      this.emit('consumer:closed', { roomSlug, peerId, consumerId: consumer.id, producerId });
    });

    return consumer;
  }

  async resumeConsumer(roomSlug: string, peerId: string, consumerId: string): Promise<void> {
    await this.findConsumer(roomSlug, peerId, consumerId).resume();
  }

  /**
   * Para de encaminhar ESTA track a ESTE par, sem desfazer a assinatura.
   * É o "parar de assistir" de uma tela: o SFU deixa de mandar os 12-25 Mbps
   * a quem não está olhando, que é a única forma de o botão aliviar a banda.
   */
  async pauseConsumer(roomSlug: string, peerId: string, consumerId: string): Promise<void> {
    await this.findConsumer(roomSlug, peerId, consumerId).pause();
  }

  /** O que este par publicou agora — para o proxy anunciar no roster. */
  publishedTracks(
    roomSlug: string,
    peerId: string,
  ): { producerId: string; kind: 'audio' | 'video'; trackKind: MediasoupTrackKind }[] {
    const peer = this.rooms.get(roomSlug)?.peers.get(peerId);
    if (peer === undefined) return [];
    return [...peer.producers.values()].map(({ producer, trackKind }) => ({
      producerId: producer.id,
      kind: producer.kind,
      trackKind,
    }));
  }

  /** Retrato de todas as tracks no ar na sala — para quem acabou de chegar assinar sem esperar um `track:announced` que já passou. */
  publishedTracksInRoom(roomSlug: string): TrackAnnouncedEvent[] {
    const room = this.rooms.get(roomSlug);
    if (room === undefined) return [];
    return [...room.producers.values()].map(({ producer, ownerPeerId, trackKind }) => ({
      roomSlug,
      peerId: ownerPeerId,
      producerId: producer.id,
      kind: producer.kind,
      trackKind,
    }));
  }

  currentSpeakers(roomSlug: string): SignalSpeaker[] {
    return this.rooms.get(roomSlug)?.speakers ?? [];
  }

  /** Fecha tudo que este par tinha na sala e o tira do roster. */
  removePeer(roomSlug: string, peerId: string, reason: PeerRemovalReason = 'left'): void {
    const room = this.rooms.get(roomSlug);
    const peer = room?.peers.get(peerId);
    let changed = false;

    if (room !== undefined && peer !== undefined) {
      peer.transports.send?.close();
      peer.transports.recv?.close();
      room.peers.delete(peerId);
      const roomRouter = room.routers.get(peer.routerKey);
      if (roomRouter !== undefined) {
        roomRouter.peerIds.delete(peerId);
        roomRouter.speaking.delete(peerId);
        this.releaseRouterIfIdle(room, roomRouter);
      }
      this.publishSpeakers(room);
      changed = true;
    }

    const presenceRoom = this.presence.get(roomSlug);
    if (presenceRoom?.delete(peerId) === true) changed = true;
    if (presenceRoom !== undefined && presenceRoom.size === 0) this.presence.delete(roomSlug);

    if (room !== undefined) this.closeRoomIfEmpty(room);
    if (!changed) return;
    this.emit('peer:removed', { roomSlug, peerId, reason });
    this.emit('presence', roomSlug);
  }

  // -------------------------------------------------------------------------
  // Presença
  // -------------------------------------------------------------------------

  /** Registra/renova a presença de um par na sala — chamado quando um canal de controle dele conecta. */
  setPresence(roomSlug: string, peerId: string, displayName: string): void {
    let presenceRoom = this.presence.get(roomSlug);
    if (presenceRoom === undefined) {
      presenceRoom = new Map();
      this.presence.set(roomSlug, presenceRoom);
    }
    const existing = presenceRoom.get(peerId);
    presenceRoom.set(peerId, { displayName, joinedAt: existing?.joinedAt ?? Date.now() });
    if (existing === undefined || existing.displayName !== displayName) {
      this.emit('presence', roomSlug);
    }
  }

  /** Quem está na sala agora, para o roster do Socket.IO e para `apps/api` consultar via HTTP interno. */
  listPresence(roomSlug: string): { peerId: string; displayName: string; joinedAt: string }[] {
    const presenceRoom = this.presence.get(roomSlug);
    if (presenceRoom === undefined) return [];
    return [...presenceRoom.entries()].map(([peerId, entry]) => ({
      peerId,
      displayName: entry.displayName,
      joinedAt: new Date(entry.joinedAt).toISOString(),
    }));
  }

  /** Agregado de todas as salas com presença — alimenta `MediasoupService.liveRooms()`. */
  listRoomsWithPresence(): { slug: string; participants: number; earliestJoinedAt: string }[] {
    const result: { slug: string; participants: number; earliestJoinedAt: string }[] = [];
    for (const [slug, presenceRoom] of this.presence.entries()) {
      if (presenceRoom.size === 0) continue;
      const earliest = Math.min(...[...presenceRoom.values()].map((entry) => entry.joinedAt));
      result.push({ slug, participants: presenceRoom.size, earliestJoinedAt: new Date(earliest).toISOString() });
    }
    return result;
  }

  stats(): RegistryStats {
    let peers = 0;
    let producers = 0;
    let consumers = 0;
    let roomsSpanningWorkers = 0;
    for (const room of this.rooms.values()) {
      peers += room.peers.size;
      producers += room.producers.size;
      for (const peer of room.peers.values()) consumers += peer.consumers.size;
      if (room.routers.size > 1) roomsSpanningWorkers += 1;
    }
    return { rooms: this.rooms.size, peers, producers, consumers, roomsSpanningWorkers };
  }

  // -------------------------------------------------------------------------
  // Salas, Routers e pontes
  // -------------------------------------------------------------------------

  /** Síncrono de propósito: a sala existe no mapa ANTES de qualquer `await`, ver `Room.routerCreations`. */
  private ensureRoom(roomSlug: string): Room {
    let room = this.rooms.get(roomSlug);
    if (room === undefined) {
      room = {
        slug: roomSlug,
        routers: new Map(),
        routerCreations: new Map(),
        primaryKey: null,
        primaryPending: null,
        peers: new Map(),
        peerCreations: new Map(),
        producers: new Map(),
        pipes: new Map(),
        speakers: [],
        speakersKey: '',
      };
      this.rooms.set(roomSlug, room);
    }
    return room;
  }

  private getRoom(roomSlug: string): Room {
    const room = this.rooms.get(roomSlug);
    if (room === undefined) throw new NotFoundError(`Sala '${roomSlug}' não existe no SFU.`);
    return room;
  }

  private getPeer(room: Room, peerId: string): Peer {
    const peer = room.peers.get(peerId);
    if (peer === undefined) throw new NotFoundError(`O par '${peerId}' não tem sessão de mídia nesta sala.`);
    return peer;
  }

  private routerOf(room: Room, peer: Peer): RoomRouter {
    const roomRouter = room.routers.get(peer.routerKey);
    if (roomRouter === undefined) throw new NotFoundError('O Router deste par não existe mais.');
    return roomRouter;
  }

  private ensurePeer(room: Room, peerId: string): Promise<Peer> {
    const existing = room.peers.get(peerId);
    if (existing !== undefined) return Promise.resolve(existing);

    let creation = room.peerCreations.get(peerId);
    if (creation === undefined) {
      creation = this.createPeer(room, peerId).finally(() => {
        room.peerCreations.delete(peerId);
        // Se a criação falhou e não sobrou ninguém, a sala não fica para trás.
        this.closeRoomIfEmpty(room);
      });
      room.peerCreations.set(peerId, creation);
    }
    return creation;
  }

  private async createPeer(room: Room, peerId: string): Promise<Peer> {
    for (let attempt = 0; ; attempt += 1) {
      const roomRouter = await this.assignRouter(room);
      // O último par deste Router pode ter saído entre a escolha e agora, e o
      // Router foi liberado junto. Escolhe de novo em vez de entrar num
      // Router fechado.
      if (roomRouter.router.closed) {
        if (attempt >= 2) throw new Error('não foi possível alocar um Router para a sala');
        continue;
      }
      const peer: Peer = {
        id: peerId,
        sessionId: randomUUID(),
        routerKey: roomRouter.key,
        transports: { send: null, recv: null },
        producers: new Map(),
        consumers: new Map(),
        rtpCapabilities: null,
      };
      room.peers.set(peerId, peer);
      roomRouter.peerIds.add(peerId);
      return peer;
    }
  }

  private resetPeerMedia(peer: Peer): void {
    const hadTransports = peer.transports.send !== null || peer.transports.recv !== null;
    peer.transports.send?.close();
    peer.transports.recv?.close();
    peer.transports = { send: null, recv: null };
    peer.rtpCapabilities = null;
    if (hadTransports) peer.sessionId = randomUUID();
  }

  /**
   * Em qual Router da sala um par novo entra.
   *
   * A ordem é a de quem quer a sala JUNTA: o principal enquanto couber;
   * depois um Router que a sala já tenha em Worker com folga; só então um
   * Worker novo. Cada Router a mais é uma ponte a mais por track, e ponte é
   * custo — pago só quando ficar no mesmo Worker custaria qualidade.
   */
  private async assignRouter(room: Room): Promise<RoomRouter> {
    const primary = await this.primaryRouter(room);
    if (!this.pool.isSaturated(primary.slot)) return primary;

    const withRoom = [...room.routers.values()].filter(
      (roomRouter) => !this.pool.isSaturated(roomRouter.slot),
    );
    if (withRoom.length > 0) {
      const slot = this.pool.leastLoaded(withRoom.map((roomRouter) => roomRouter.slot));
      return room.routers.get(slot.index) ?? primary;
    }

    const freest = this.pool.leastLoaded();
    if (this.pool.isSaturated(freest)) {
      // O nó inteiro está cheio. Abrir Router novo só somaria pontes a
      // Workers que já não dão conta: fica no menos pior dos que a sala tem.
      const slot = this.pool.leastLoaded([...room.routers.values()].map((roomRouter) => roomRouter.slot));
      return room.routers.get(slot.index) ?? primary;
    }
    return this.ensureRouter(room, freest);
  }

  private primaryRouter(room: Room): Promise<RoomRouter> {
    const current = room.primaryKey === null ? undefined : room.routers.get(room.primaryKey);
    if (current !== undefined) return Promise.resolve(current);

    // Sala nova (ou que ficou sem principal): o Worker mais folgado do nó.
    room.primaryPending ??= this.ensureRouter(room, this.pool.leastLoaded())
      .then((roomRouter) => {
        room.primaryKey = roomRouter.key;
        return roomRouter;
      })
      .finally(() => {
        room.primaryPending = null;
      });
    return room.primaryPending;
  }

  private ensureRouter(room: Room, slot: WorkerSlot): Promise<RoomRouter> {
    const existing = room.routers.get(slot.index);
    if (existing !== undefined) return Promise.resolve(existing);

    let creation = room.routerCreations.get(slot.index);
    if (creation === undefined) {
      creation = this.createRoomRouter(room, slot).finally(() => {
        room.routerCreations.delete(slot.index);
      });
      room.routerCreations.set(slot.index, creation);
    }
    return creation;
  }

  private async createRoomRouter(room: Room, slot: WorkerSlot): Promise<RoomRouter> {
    const router = await slot.worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    let audioLevelObserver: mediasoup.types.AudioLevelObserver;
    try {
      audioLevelObserver = await router.createAudioLevelObserver({
        maxEntries: SPEAKING_MAX_ENTRIES,
        threshold: SPEAKING_THRESHOLD_DBOV,
        interval: SPEAKING_INTERVAL_MS,
      });
    } catch (error) {
      router.close();
      throw error;
    }

    const roomRouter: RoomRouter = {
      key: slot.index,
      slot,
      router,
      audioLevelObserver,
      peerIds: new Set(),
      speaking: new Map(),
    };
    slot.routers += 1;
    router.observer.once('close', () => {
      slot.routers -= 1;
    });

    audioLevelObserver.on('volumes', (volumes) => {
      const speaking = new Map<string, number>();
      for (const { producer, volume } of volumes) {
        const owner = room.producers.get(producer.id)?.ownerPeerId;
        if (owner !== undefined) speaking.set(owner, volume);
      }
      roomRouter.speaking = speaking;
      this.publishSpeakers(room);
    });
    audioLevelObserver.on('silence', () => {
      if (roomRouter.speaking.size === 0) return;
      roomRouter.speaking = new Map();
      this.publishSpeakers(room);
    });

    room.routers.set(slot.index, roomRouter);
    return roomRouter;
  }

  /**
   * Leva um producer do Router onde nasceu até `target`, uma vez só.
   *
   * A ponte é por track e só existe se alguém do outro lado assina: sala que
   * cabe num Worker nunca cria nenhuma. O mapa guarda a PROMESSA, e não o
   * resultado, porque vinte pessoas assinando a mesma tela no mesmo instante
   * precisam esperar a mesma ponte em vez de pedir vinte.
   */
  private ensurePiped(room: Room, origin: ProducerEntry, target: RoomRouter): Promise<void> {
    const key = `${target.key}:${origin.producer.id}`;
    const existing = room.pipes.get(key);
    if (existing !== undefined) return existing;

    const source = room.routers.get(origin.routerKey);
    if (source === undefined) {
      return Promise.reject(new NotFoundError('O Router de origem desta track não existe mais.'));
    }

    const units = LOAD_UNITS[origin.trackKind];
    const pending: Promise<void> = source.router
      .pipeToRouter({
        producerId: origin.producer.id,
        router: target.router,
        listenInfo: this.options.pipeListenInfo,
      })
      .then(({ pipeConsumer, pipeProducer }) => {
        // A ponte pesa nos dois lados: é um consumer a mais no Worker de
        // origem e um producer a mais no de destino.
        if (pipeConsumer !== undefined) this.account(source.slot, units, pipeConsumer.observer);
        if (pipeProducer !== undefined) {
          this.account(target.slot, units, pipeProducer.observer);
          pipeProducer.observer.once('close', () => {
            if (room.pipes.get(key) === pending) room.pipes.delete(key);
          });
        }
      })
      .catch((error: unknown) => {
        if (room.pipes.get(key) === pending) room.pipes.delete(key);
        throw error;
      });
    room.pipes.set(key, pending);
    return pending;
  }

  /**
   * Router sem ninguém é fechado na hora. Deixá-lo vivo manteria as pontes
   * que chegam nele encaminhando cada pacote da sala para um Worker onde
   * ninguém assiste.
   */
  private releaseRouterIfIdle(room: Room, roomRouter: RoomRouter): void {
    if (roomRouter.peerIds.size > 0) return;
    room.routers.delete(roomRouter.key);
    roomRouter.router.close();
    for (const key of [...room.pipes.keys()]) {
      if (key.startsWith(`${roomRouter.key}:`)) room.pipes.delete(key);
    }
    if (room.primaryKey !== roomRouter.key) return;
    // O principal passa a ser onde a sala tem mais gente.
    let next: RoomRouter | null = null;
    for (const candidate of room.routers.values()) {
      if (next === null || candidate.peerIds.size > next.peerIds.size) next = candidate;
    }
    room.primaryKey = next?.key ?? null;
  }

  /**
   * Sala sem sessão de mídia não segura Router nem memória de Worker. Quem só
   * tem o socket de presença aberto continua no roster — isso mora em
   * `presence`, não aqui.
   */
  private closeRoomIfEmpty(room: Room): void {
    if (this.rooms.get(room.slug) !== room) return;
    if (
      room.peers.size > 0 ||
      room.peerCreations.size > 0 ||
      room.routerCreations.size > 0 ||
      room.primaryPending !== null
    ) {
      return;
    }
    for (const roomRouter of room.routers.values()) roomRouter.router.close();
    room.routers.clear();
    room.pipes.clear();
    this.rooms.delete(room.slug);
  }

  /**
   * Junta os falantes de todos os Routers da sala e avisa SÓ quando o
   * conjunto muda. O medidor dispara cinco vezes por segundo enquanto alguém
   * fala; repassar cada disparo seria tráfego para dizer a mesma coisa.
   */
  private publishSpeakers(room: Room): void {
    const merged = new Map<string, number>();
    for (const roomRouter of room.routers.values()) {
      for (const [peerId, volume] of roomRouter.speaking) {
        merged.set(peerId, Math.max(volume, merged.get(peerId) ?? -127));
      }
    }
    const speakers = [...merged]
      .map(([peerId, volume]) => ({ peerId, volume }))
      .sort((a, b) => b.volume - a.volume || a.peerId.localeCompare(b.peerId));
    const key = speakers
      .map((speaker) => speaker.peerId)
      .sort()
      .join('\n');
    if (key === room.speakersKey) return;
    room.speakersKey = key;
    room.speakers = speakers;
    this.emit('speakers', { roomSlug: room.slug, speakers });
  }

  /** Soma o peso ao Worker agora e devolve quando o objeto fechar — por qualquer caminho. */
  private account(
    slot: WorkerSlot,
    units: number,
    observer: { once(event: 'close', listener: () => void): unknown },
  ): void {
    slot.units += units;
    observer.once('close', () => {
      slot.units -= units;
    });
  }

  private findTransport(peer: Peer, transportId: string): WebRtcTransport {
    const transport =
      peer.transports.send?.id === transportId
        ? peer.transports.send
        : peer.transports.recv?.id === transportId
          ? peer.transports.recv
          : null;
    if (transport === null) {
      throw new NotFoundError(`Transport '${transportId}' não existe para este par.`);
    }
    return transport;
  }

  private findConsumer(roomSlug: string, peerId: string, consumerId: string): Consumer {
    const consumer = this.rooms.get(roomSlug)?.peers.get(peerId)?.consumers.get(consumerId);
    if (consumer === undefined) {
      throw new NotFoundError(`Consumer '${consumerId}' não existe para este par.`);
    }
    return consumer;
  }
}

export class NotFoundError extends Error {}
export class BadRequestError extends Error {}
