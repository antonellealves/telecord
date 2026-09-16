import * as mediasoup from 'mediasoup';
import type {
  MediasoupTrackKind,
} from '@telecord/shared';

/**
 * Estado ao vivo do SFU: um `Router` por sala, um `Peer` por participante
 * conectado. Tudo em memória — de propósito, mesmo espírito do
 * `PeersService` do modo P2P (SPEC): este processo não é o dono da verdade
 * sobre quem tem permissão de entrar (isso é o `assertMember` do proxy em
 * `apps/api`), só o dono da mídia enquanto ela está fluindo. Reiniciar o
 * processo derruba toda sala ativa — comportamento aceito, mesmo trade-off
 * de reiniciar o `livekit-server`.
 *
 * Desde a chegada do canal de presença por Socket.IO (`presence.ts`), este
 * registry também é o dono da PRESENÇA ao vivo (quem está na sala agora,
 * `displayName`, `joinedAt`) — antes essa informação só existia em
 * `PeerPresence` no Prisma, via `apps/api`. Presença aqui é mantida à parte
 * de `peers` (que continua existindo só para quem tem transporte/mídia),
 * porque uma pessoa pode ter socket conectado sem nunca ter publicado nada.
 *
 * Codec Opus com DTX/RED espelhando `apps/web/src/lib/media.ts` (Parte 1):
 * mesma meta de qualidade "estúdio" dos dois lados do transporte, para que
 * trocar de `livekit` para `mediasoup` numa sala não seja downgrade de voz.
 */
const MEDIA_CODECS: mediasoup.types.RouterRtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    // `channels` no RTP do Opus é sempre 2 por definição do RFC 7587 (é o
    // número de canais do STREAM Opus, não da captura) — o cliente publica
    // mono via `sprop-stereo=0`/`stereo=0` nos fmtp, então baixar isto para 1
    // aqui só faz o `canProduce('audio')` do Device falhar em navegadores que
    // seguem o RFC à risca (o codec deixa de "casar" com o suportado pelo
    // Router). O mono já é garantido do outro lado (`channelCount: 1` em
    // `useMediasoupTalkControls`), sem precisar mexer aqui.
    channels: 2,
    parameters: {
      // SEM `usedtx`: a combinação DTX+FEC do Opus é um gatilho conhecido de
      // áudio mudo/cortado em várias versões do Chromium — o encoder para de
      // mandar pacote nos trechos "silenciosos" que ele mesmo detecta, e a
      // detecção é agressiva o bastante para cortar início de fala. Era
      // plausível ser a causa de "mic abre mas não sai som" enquanto vídeo
      // (sem DTX) funcionava normalmente pelo mesmo transporte. `useinbandfec`
      // sozinho já dá a resiliência a perda de pacote que se queria.
      useinbandfec: 1,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
  },
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90000,
    parameters: { 'profile-id': 2 },
  },
];

interface PeerTransports {
  send: mediasoup.types.WebRtcTransport | null;
  recv: mediasoup.types.WebRtcTransport | null;
}

interface Peer {
  id: string;
  transports: PeerTransports;
  producers: Map<string, { producer: mediasoup.types.Producer; trackKind: MediasoupTrackKind }>;
  consumers: Map<string, mediasoup.types.Consumer>;
}

interface Room {
  router: mediasoup.types.Router;
  peers: Map<string, Peer>;
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

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  /** `roomSlug -> peerId -> presença`, mantido pelo canal Socket.IO (`presence.ts`), separado de `Room.peers` — ver docstring do topo do arquivo. */
  private readonly presence = new Map<string, Map<string, PresenceEntry>>();
  /**
   * Ligado por `presence.ts` depois que o Socket.IO sobe — `produce()`/fechamento
   * de producer chamam isto para avisar a sala em tempo real, substituindo o
   * anúncio de tracks que antes só chegava no próximo tick do heartbeat de 4s
   * (`ANNOUNCE_TICK_MS` no cliente). `null` até `presence.ts` chamar `setTrackListeners`.
   */
  private onTrackAnnounced: ((event: TrackAnnouncedEvent) => void) | null = null;
  private onTrackClosed: ((event: TrackClosedEvent) => void) | null = null;

  constructor(
    private readonly worker: mediasoup.types.Worker,
    private readonly announcedIp: string,
  ) {}

  setTrackListeners(
    onTrackAnnounced: (event: TrackAnnouncedEvent) => void,
    onTrackClosed: (event: TrackClosedEvent) => void,
  ): void {
    this.onTrackAnnounced = onTrackAnnounced;
    this.onTrackClosed = onTrackClosed;
  }

  async getOrCreateRoom(roomSlug: string): Promise<Room> {
    const existing = this.rooms.get(roomSlug);
    if (existing !== undefined) return existing;

    const router = await this.worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    const room: Room = { router, peers: new Map() };
    this.rooms.set(roomSlug, room);
    return room;
  }

  private getRoom(roomSlug: string): Room {
    const room = this.rooms.get(roomSlug);
    if (room === undefined) throw new NotFoundError(`Sala '${roomSlug}' não existe no SFU.`);
    return room;
  }

  private getOrCreatePeer(room: Room, peerId: string): Peer {
    let peer = room.peers.get(peerId);
    if (peer === undefined) {
      peer = {
        id: peerId,
        transports: { send: null, recv: null },
        producers: new Map(),
        consumers: new Map(),
      };
      room.peers.set(peerId, peer);
    }
    return peer;
  }

  async routerRtpCapabilities(roomSlug: string): Promise<mediasoup.types.RtpCapabilities> {
    const room = await this.getOrCreateRoom(roomSlug);
    return room.router.rtpCapabilities;
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
  ): Promise<mediasoup.types.WebRtcTransport> {
    const room = this.getRoom(roomSlug);
    const peer = this.getOrCreatePeer(room, peerId);

    const transport = await room.router.createWebRtcTransport({
      listenIps: [{ ip: '0.0.0.0', announcedIp: this.announcedIp }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      // Teto de banda por transporte de ENVIO. Câmera+mic de uma pessoa não
      // deveria passar disto; a tela usa perfil próprio no lado do cliente
      // (mesmo teto de `screenEncoding` da Parte 1) mas o SFU não distingue
      // por track — o limite aqui é generoso o bastante para os dois juntos.
      initialAvailableOutgoingBitrate: 1_000_000,
    });

    /*
     * O mesmo `peerId` pode pedir um transporte novo sem o antigo ter
     * fechado — o caso comum é dar F5: a aba nova reconecta com o MESMO
     * `peerId` (estável via localStorage) e chama `createTransport` de novo
     * antes do socket de presença da aba antiga notificar o `disconnect`.
     * Sem fechar o antigo aqui, ele ficava órfão para sempre — nunca mais
     * referenciado por `peer.transports`, mas com o `WebRtcTransport` e os
     * producers dele (a tela que a aba antiga compartilhava) vivos no
     * mediasoup, PRA SEMPRE, porque só chega a fechar se alguém chamar
     * `.close()` nele — nada mais faz isso sozinho. Cada refresh empilhava
     * mais um "fantasma" compartilhando a mesma tela — o sintoma era o
     * mesmo participante aparecendo compartilhando várias vezes depois de
     * recarregar a página algumas vezes.
     */
    const anterior = direction === 'send' ? peer.transports.send : peer.transports.recv;
    if (anterior !== null && anterior.id !== transport.id) {
      anterior.close();
    }

    if (direction === 'send') peer.transports.send = transport;
    else peer.transports.recv = transport;

    transport.on('dtlsstatechange', (state) => {
      if (state === 'closed') transport.close();
    });

    return transport;
  }

  async connectTransport(
    roomSlug: string,
    peerId: string,
    transportId: string,
    dtlsParameters: mediasoup.types.DtlsParameters,
  ): Promise<void> {
    const transport = this.findTransport(roomSlug, peerId, transportId);
    await transport.connect({ dtlsParameters });
  }

  async produce(
    roomSlug: string,
    peerId: string,
    transportId: string,
    kind: mediasoup.types.MediaKind,
    rtpParameters: mediasoup.types.RtpParameters,
    trackKind: MediasoupTrackKind,
  ): Promise<mediasoup.types.Producer> {
    const room = this.getRoom(roomSlug);
    const peer = this.getOrCreatePeer(room, peerId);
    const transport = this.findTransport(roomSlug, peerId, transportId);

    const producer = await transport.produce({ kind, rtpParameters });
    peer.producers.set(producer.id, { producer, trackKind });

    producer.on('transportclose', () => {
      peer.producers.delete(producer.id);
      this.onTrackClosed?.({ roomSlug, peerId, producerId: producer.id });
    });

    this.onTrackAnnounced?.({ roomSlug, peerId, producerId: producer.id, kind: producer.kind, trackKind });

    return producer;
  }

  async consume(
    roomSlug: string,
    peerId: string,
    transportId: string,
    producerId: string,
    rtpCapabilities: mediasoup.types.RtpCapabilities,
  ): Promise<mediasoup.types.Consumer> {
    const room = this.getRoom(roomSlug);
    const peer = this.getOrCreatePeer(room, peerId);
    const transport = this.findTransport(roomSlug, peerId, transportId);

    if (!room.router.canConsume({ producerId, rtpCapabilities })) {
      throw new BadRequestError('O Device do assinante não suporta os codecs desta track.');
    }

    // Assinante começa pausado — a UI manda `resume` só depois de o
    // `<audio>`/`<video>` estar pronto para tocar, evitando pacotes
    // descartados antes de haver quem os consuma no navegador.
    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: true,
    });
    peer.consumers.set(consumer.id, consumer);

    consumer.on('transportclose', () => {
      peer.consumers.delete(consumer.id);
    });
    consumer.on('producerclose', () => {
      peer.consumers.delete(consumer.id);
    });

    return consumer;
  }

  async resumeConsumer(roomSlug: string, peerId: string, consumerId: string): Promise<void> {
    const room = this.getRoom(roomSlug);
    const peer = room.peers.get(peerId);
    const consumer = peer?.consumers.get(consumerId);
    if (consumer === undefined) {
      throw new NotFoundError(`Consumer '${consumerId}' não existe para este par.`);
    }
    await consumer.resume();
  }

  /** O que este par publicou agora — para o proxy anunciar no roster. */
  publishedTracks(
    roomSlug: string,
    peerId: string,
  ): { producerId: string; kind: 'audio' | 'video'; trackKind: MediasoupTrackKind }[] {
    const room = this.rooms.get(roomSlug);
    const peer = room?.peers.get(peerId);
    if (peer === undefined) return [];
    return [...peer.producers.values()].map(({ producer, trackKind }) => ({
      producerId: producer.id,
      kind: producer.kind,
      trackKind,
    }));
  }

  /** Snapshot de todas as tracks publicadas na sala agora — para quem acabou de conectar o socket de presença consumir sem esperar um `track:announced` que já passou. */
  publishedTracksInRoom(roomSlug: string): TrackAnnouncedEvent[] {
    const room = this.rooms.get(roomSlug);
    if (room === undefined) return [];
    const out: TrackAnnouncedEvent[] = [];
    for (const [peerId, peer] of room.peers.entries()) {
      for (const { producer, trackKind } of peer.producers.values()) {
        out.push({ roomSlug, peerId, producerId: producer.id, kind: producer.kind, trackKind });
      }
    }
    return out;
  }

  /** Fecha tudo que este par tinha na sala — chamado quando ele sai (SPEC: `leave`, e agora também pelo `disconnect` do socket de presença). */
  removePeer(roomSlug: string, peerId: string): void {
    const room = this.rooms.get(roomSlug);
    const peer = room?.peers.get(peerId);
    if (peer !== undefined) {
      peer.transports.send?.close();
      peer.transports.recv?.close();
      room?.peers.delete(peerId);
    }

    const presenceRoom = this.presence.get(roomSlug);
    presenceRoom?.delete(peerId);
    if (presenceRoom !== undefined && presenceRoom.size === 0) {
      this.presence.delete(roomSlug);
    }

    // Sala vazia não precisa continuar com Router vivo — libera a memória do
    // Worker, crítica nesta VM (ver setup-vm.sh: ~500MB reais de RAM). "Vazia"
    // soma peers de mídia E peers só-de-presença: alguém que só teve socket
    // conectado, sem nunca ter publicado/consumido nada, ainda ocupa a sala.
    if (room !== undefined && room.peers.size === 0 && (this.presence.get(roomSlug)?.size ?? 0) === 0) {
      room.router.close();
      this.rooms.delete(roomSlug);
    }
  }

  /** Registra/renova a presença de um par na sala — chamado ao conectar (ou reconectar) o socket de presença. */
  setPresence(roomSlug: string, peerId: string, displayName: string): void {
    let presenceRoom = this.presence.get(roomSlug);
    if (presenceRoom === undefined) {
      presenceRoom = new Map();
      this.presence.set(roomSlug, presenceRoom);
    }
    const existing = presenceRoom.get(peerId);
    presenceRoom.set(peerId, { displayName, joinedAt: existing?.joinedAt ?? Date.now() });
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

  private findTransport(
    roomSlug: string,
    peerId: string,
    transportId: string,
  ): mediasoup.types.WebRtcTransport {
    const room = this.getRoom(roomSlug);
    const peer = room.peers.get(peerId);
    const transport =
      peer?.transports.send?.id === transportId
        ? peer.transports.send
        : peer?.transports.recv?.id === transportId
          ? peer.transports.recv
          : null;
    if (transport === null || transport === undefined) {
      throw new NotFoundError(`Transport '${transportId}' não existe para este par.`);
    }
    return transport;
  }
}

export class NotFoundError extends Error {}
export class BadRequestError extends Error {}

/**
 * Um `Worker` só.
 *
 * A VM (`E2.1.Micro`) tem só um vCPU fracionado — um Worker por núcleo é a
 * recomendação do mediasoup, e aqui um núcleo é tudo que existe. Múltiplos
 * workers nesta shape dividiriam um processador que já é escasso, sem ganho.
 */
export async function createWorker(rtcMinPort: number, rtcMaxPort: number): Promise<mediasoup.types.Worker> {
  const worker = await mediasoup.createWorker({
    rtcMinPort,
    rtcMaxPort,
    logLevel: 'warn',
  });
  worker.on('died', () => {
    // mediasoup mata o processo em vez de deixar o Worker nativo (C++) num
    // estado indefinido — o supervisor do Docker (`restart: unless-stopped`)
    // sobe um processo novo, mesmo padrão de resiliência do `livekit-server`.
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ scope: 'mediasoup-sfu', event: 'worker_died' }));
    process.exit(1);
  });
  return worker;
}
