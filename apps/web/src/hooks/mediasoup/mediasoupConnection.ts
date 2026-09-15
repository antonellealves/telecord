import { Device } from 'mediasoup-client';
import type { Transport } from 'mediasoup-client/types';
import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerPresenceEvents,
  MediasoupTrackKind,
  PeerInfo,
  PresenceChatMessage,
  PresenceModerationCommand,
  PresenceRosterUpdate,
  PresenceTrackAnnounced,
  PresenceTrackClosed,
  ServerToClientPresenceEvents,
} from '@telecord/shared';
import { MEDIASOUP_PUBLIC_URL } from '../../lib/config';
import { peerLeave } from '../../lib/peers';
import {
  fetchMediasoupConfig,
  msConnectTransport,
  msConsume,
  msCreateTransport,
  msLeave,
  msProduce,
  msResumeConsumer,
} from '../../lib/mediasoup';

export type MediasoupConnectionState = 'new' | 'connecting' | 'connected' | 'failed' | 'disconnected';

export interface LocalTrackHandle {
  producerId: string;
  kind: 'audio' | 'video';
  trackKind: MediasoupTrackKind;
  /** A track de origem — quem chamou `produce` continua dono dela (parar é responsabilidade de quem publicou). */
  track: MediaStreamTrack;
}

export interface RemoteTrackHandle {
  consumerId: string;
  producerId: string;
  ownerPeerId: string;
  kind: 'audio' | 'video';
  trackKind: MediasoupTrackKind;
  track: MediaStreamTrack;
}

export interface MediasoupConnectionEvents {
  onStateChange: (state: MediasoupConnectionState) => void;
  onRosterChange: (peers: PeerInfo[]) => void;
  onRemoteTrack: (handle: RemoteTrackHandle) => void;
  onRemoteTrackEnded: (consumerId: string) => void;
  onLocalTrackChange: (tracks: LocalTrackHandle[]) => void;
  onError: (message: string) => void;
  onAttributesReceived: (peerId: string, attributes: Record<string, string>) => void;
  onData: (payload: Uint8Array, fromPeerId: string) => void;
  /**
   * O painel admin pediu mudo forçado no mic local — cooperativo, sem
   * equivalente de servidor no SFU mediasoup (ver `MediasoupModerationService`
   * no backend). A conexão já pausa/retoma o `track.enabled` do producer de
   * áudio sozinha; isto é só para a UI espelhar o estado do botão de mic.
   */
  onForceMuted: (muted: boolean) => void;
  /** O painel admin pediu para mover este par para outra sala — mesmo espírito do "mover" do LiveKit, cooperativo aqui. */
  onForceMoved: (roomSlug: string) => void;
}

/**
 * Conexão de baixo nível com o SFU mediasoup: Device, os dois `Transport`s
 * (envio/recepção), produtores e consumidores, e o roster do telecord — tudo
 * ao vivo pelo socket de presença (ver `connectPresenceSocket`), sem
 * nenhum polling HTTP remanescente deste lado.
 *
 * Não é um hook — é uma classe simples, instanciada uma vez por sala e
 * mantida numa ref pelos hooks React que a usam (useMediasoupParticipants,
 * useMediasoupChat, etc.). A separação existe porque várias dessas peças de
 * UI precisam da MESMA conexão ao mesmo tempo (participantes, chat, controle
 * de mic/câmera/tela) — reabrir uma conexão por hook duplicaria Device e
 * Transports e a sala veria cada participante "duas vezes".
 *
 * ## Por que não é o `RoomEngine`/`RoomLike` que cheguei a desenhar antes
 *
 * Uma tentativa anterior era fazer isto imitar a API do `Room` do
 * livekit-client o bastante para os hooks JÁ EXISTENTES (useParticipantViews,
 * useScreenShares, etc.) funcionarem sem duplicação. Não fechou: esses hooks
 * fazem `instanceof RemoteAudioTrack` (classe concreta do livekit-client, sem
 * como ser satisfeita por um objeto parecido) e usam opções de publicação
 * (encoding de vídeo, degradationPreference) que são específicas do SDK do
 * LiveKit. Forçar a generalização arriscava regressão na sala LiveKit em
 * produção — daí a decisão de manter os dois caminhos SEPARADOS: esta classe
 * e os hooks `hooks/mediasoup/*` são só para o transporte mediasoup, e nada
 * em `hooks/*.ts` (LiveKit) foi tocado.
 */
export class MediasoupConnection {
  private device: Device | null = null;
  private sendTransport: Transport | null = null;
  private recvTransport: Transport | null = null;
  private readonly localTracks = new Map<string, LocalTrackHandle>();
  private readonly consumedProducerIds = new Set<string>();
  private roster: PeerInfo[] = [];
  private state: MediasoupConnectionState = 'new';
  private presenceSocket: Socket<ServerToClientPresenceEvents, ClientToServerPresenceEvents> | null = null;
  /**
   * Ouvintes de chat, à parte de `MediasoupConnectionEvents` (que tem UM dono
   * só, `useMediasoupEngine`) — `useMediasoupChat` é montado DEPOIS do
   * engine e precisa se inscrever na conexão já criada, não no construtor
   * dela. `Set` porque não há por que limitar a um só (StrictMode monta o
   * hook duas vezes em dev, por exemplo) nem duplicar entrega.
   */
  private readonly chatListeners = new Set<(fromPeer: string, displayName: string, body: string) => void>();
  private alive = true;
  /** Evita disparar `onForceMuted`/`onForceMoved` de novo a cada tick enquanto o comando continuar o mesmo. */
  private lastForceMuted = false;
  private lastMoveTo: string | null = null;

  constructor(
    private readonly roomId: string,
    private readonly peerId: string,
    private readonly displayName: string,
    private readonly events: MediasoupConnectionEvents,
  ) {}

  async connect(): Promise<void> {
    this.setState('connecting');
    try {
      /*
       * `fetchMediasoupConfig` já FAZ o heartbeat inicial do lado do servidor
       * (ver `MediasoupService.clientConfig`) — é o que dá a `assertMember`
       * uma linha de presença fresca antes de liberar `createTransport`, e é
       * quem assina o `presenceToken` usado logo abaixo. Não há mais heartbeat
       * HTTP separado antes de criar transporte.
       */
      const config = await fetchMediasoupConfig(this.roomId, this.peerId, this.displayName);
      if (!this.alive) return;
      if (!config.enabled || config.presenceToken === null) {
        this.events.onError('O mediasoup não está configurado neste servidor.');
        this.setState('failed');
        return;
      }

      const device = new Device();
      await device.load({ routerRtpCapabilities: config.routerRtpCapabilities as never });
      if (!this.alive) return;
      this.device = device;

      this.connectPresenceSocket(config.presenceToken);

      const sendInfo = await msCreateTransport(this.roomId, { peerId: this.peerId, direction: 'send' });
      const recvInfo = await msCreateTransport(this.roomId, { peerId: this.peerId, direction: 'recv' });
      if (!this.alive) return;

      const sendTransport = device.createSendTransport({
        id: sendInfo.id,
        iceParameters: sendInfo.iceParameters as never,
        iceCandidates: sendInfo.iceCandidates as never,
        dtlsParameters: sendInfo.dtlsParameters as never,
      });
      const recvTransport = device.createRecvTransport({
        id: recvInfo.id,
        iceParameters: recvInfo.iceParameters as never,
        iceCandidates: recvInfo.iceCandidates as never,
        dtlsParameters: recvInfo.dtlsParameters as never,
      });

      sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        msConnectTransport(this.roomId, sendTransport.id, { peerId: this.peerId, dtlsParameters })
          .then(() => callback())
          .catch((failure: unknown) => errback(failure as Error));
      });
      sendTransport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
        const trackKind = (appData as { trackKind?: MediasoupTrackKind }).trackKind ?? 'mic';
        msProduce(this.roomId, sendTransport.id, { peerId: this.peerId, kind, rtpParameters, trackKind })
          .then(({ producerId }) => callback({ id: producerId }))
          .catch((failure: unknown) => errback(failure as Error));
      });
      /*
       * NÃO é aqui que se decide "conectado" para a UI.
       *
       * `connectionstatechange` só dispara depois que o `WebRtcTransport`
       * completa DTLS/ICE de verdade — e isso, no mediasoup, é LAZY: o
       * handshake só começa na primeira chamada real de `produce()` (envio)
       * ou `consume()` (recepção), disparada pelo callback `connect` acima.
       * Travar a UI em "conectando…" até este evento criava uma
       * dependência circular: o botão de microfone ficava desabilitado
       * esperando "conectado", e "conectado" só chegava depois de alguém
       * publicar — o que exigia o botão habilitado. Ainda assim vale ouvir
       * o evento para detectar queda depois de já conectado.
       */
      sendTransport.on('connectionstatechange', (connState) => {
        if (!this.alive) return;
        if (connState === 'failed' || connState === 'disconnected') {
          this.setState(connState);
        }
      });

      recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        msConnectTransport(this.roomId, recvTransport.id, { peerId: this.peerId, dtlsParameters })
          .then(() => callback())
          .catch((failure: unknown) => errback(failure as Error));
      });

      this.sendTransport = sendTransport;
      this.recvTransport = recvTransport;
      this.drainPendingTracks();

      // A UI libera assim que os dois transportes existem e a presença já
      // foi anunciada (feito acima, antes de criar os transportes) — não
      // espera o handshake DTLS, que só ocorre ao publicar/assinar algo.
      this.setState('connected');
    } catch {
      if (this.alive) {
        this.events.onError('Não foi possível conectar ao servidor mediasoup.');
        this.setState('failed');
      }
    }
  }

  close(): void {
    this.alive = false;
    this.presenceSocket?.disconnect();
    this.presenceSocket = null;
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.sendTransport = null;
    this.recvTransport = null;
    this.device = null;
    this.localTracks.clear();
    this.consumedProducerIds.clear();
    // `msLeave` fecha os transportes/presença no SFU como fallback de
    // melhor-esforço (o `disconnect` do socket já faz isso do lado dele);
    // `peerLeave` continua limpando a linha `PeerPresence`/sinalização no
    // Prisma, que o socket não toca.
    void msLeave(this.roomId, this.peerId).catch(() => undefined);
    void peerLeave(this.roomId, this.peerId).catch(() => undefined);
  }

  get connectionState(): MediasoupConnectionState {
    return this.state;
  }

  get currentRoster(): PeerInfo[] {
    return this.roster;
  }

  /** Publica uma track local (mic, câmera ou tela) e devolve o handle. */
  async publish(track: MediaStreamTrack, trackKind: MediasoupTrackKind): Promise<LocalTrackHandle> {
    const transport = this.sendTransport;
    if (transport === null) {
      throw new Error('Transporte de envio ainda não está pronto.');
    }
    const producer = await transport.produce({
      track,
      appData: { trackKind },
    });
    const handle: LocalTrackHandle = {
      producerId: producer.id,
      kind: producer.kind,
      trackKind,
      track,
    };
    this.localTracks.set(producer.id, handle);
    this.events.onLocalTrackChange([...this.localTracks.values()]);
    return handle;
  }

  /** Encerra uma track local publicada (para de enviar; quem chamou já parou a track de origem). */
  unpublish(producerId: string): void {
    this.localTracks.delete(producerId);
    this.events.onLocalTrackChange([...this.localTracks.values()]);
  }

  get localTrackHandles(): LocalTrackHandle[] {
    return [...this.localTracks.values()];
  }

  /**
   * Manda uma mensagem de chat/soundboard pelo socket de presença — substitui
   * o polling de `RoomBroadcastMessage` (`msPollBroadcast`/`msSendBroadcast`).
   * Sem persistência aqui: quem entra depois não recebe histórico, mesma
   * regra que já valia (ver `pollBroadcast` em `mediasoup.service.ts`).
   * Fire-and-forget: se o socket ainda não abriu, a mensagem se perde — não
   * há fila, do mesmo jeito que `useP2PMesh.broadcast` já não enfileira.
   */
  sendChat(body: string): void {
    this.presenceSocket?.emit('chat:send', { displayName: this.displayName, body });
  }

  /** Inscreve um ouvinte de mensagens de chat/soundboard vindas de outros peers. Devolve a função para cancelar. */
  subscribeChat(listener: (fromPeer: string, displayName: string, body: string) => void): () => void {
    this.chatListeners.add(listener);
    return () => this.chatListeners.delete(listener);
  }

  /** Publica um atributo próprio no roster (ex.: "ausente") — o mesmo `PeerInfo.mediasoup` que outros já leem via heartbeat. */
  async setAttributes(_attributes: Record<string, string>): Promise<void> {
    // Reservado para uma versão futura: hoje o roster só carrega o anúncio de
    // tracks publicadas (ver `MediasoupAnnounce`), sem um campo de atributo
    // livre por participante. `useAwayMediasoup` degrada para estado local
    // (ver esse hook) até esse campo existir no protocolo.
  }

  private setState(state: MediasoupConnectionState): void {
    this.state = state;
    this.events.onStateChange(state);
  }

  /**
   * Abre o canal Socket.IO de presença direto no mediasoup-sfu — a
   * substituição do heartbeat de roster de 2.5s. `disconnect` do lado do
   * servidor (fechar aba, F5, queda de rede) é o que agora tira alguém do
   * roster de todo mundo, em vez de depender de um TTL de 20s sem renovação.
   */
  private connectPresenceSocket(presenceToken: string): void {
    const socket: Socket<ServerToClientPresenceEvents, ClientToServerPresenceEvents> = io(MEDIASOUP_PUBLIC_URL, {
      path: '/presence',
      auth: { token: presenceToken },
      reconnection: true,
    });
    this.presenceSocket = socket;

    socket.on('roster:update', (update: PresenceRosterUpdate) => {
      if (!this.alive || update.roomSlug !== this.roomId) return;
      // O socket só carrega presença pura (peerId/displayName/joinedAt) — o
      // comando de moderação vem do heartbeat de baixa cadência
      // (`startAnnounceTick`) e precisa ser preservado ao reconstruir o
      // `PeerInfo[]` que o resto da conexão espera.
      const byId = new Map(this.roster.map((peer) => [peer.peerId, peer]));
      const merged: PeerInfo[] = update.peers.map((entry) => ({
        peerId: entry.peerId,
        displayName: entry.displayName,
        isAnonymous: byId.get(entry.peerId)?.isAnonymous ?? true,
        joinedAt: entry.joinedAt,
        mediasoup: byId.get(entry.peerId)?.mediasoup ?? null,
        adminCommand: byId.get(entry.peerId)?.adminCommand ?? null,
      }));
      this.roster = merged;
      this.events.onRosterChange(merged);
    });

    // Descoberta de producers novos (mic, câmera, tela) AO VIVO — substitui a
    // varredura do heartbeat de 4s. É isto que corrige a tela preta ao
    // compartilhar: antes, o outro par só descobria o producer novo no
    // próximo tick do `startAnnounceTick`, e uma tela que MUDAVA de producer
    // (parar/recomeçar rápido) podia perder a janela.
    socket.on('track:announced', (event: PresenceTrackAnnounced) => {
      if (!this.alive || event.roomSlug !== this.roomId || event.peerId === this.peerId) return;
      if (this.consumedProducerIds.has(event.producerId)) return;
      this.consumedProducerIds.add(event.producerId);
      const device = this.device;
      const recvTransport = this.recvTransport;
      if (device === null || recvTransport === null) {
        // Ainda conectando (o socket abre antes dos transportes existirem,
        // ver `connect()`) — devolve à fila para a próxima tentativa possível.
        this.consumedProducerIds.delete(event.producerId);
        this.pendingTracks.push(event);
        return;
      }
      void this.consume(recvTransport, device, event.producerId, event.peerId, event.trackKind).catch(() => {
        this.consumedProducerIds.delete(event.producerId);
      });
    });

    socket.on('track:closed', (event: PresenceTrackClosed) => {
      if (!this.alive || event.roomSlug !== this.roomId) return;
      this.consumedProducerIds.delete(event.producerId);
    });

    // Mute/move do painel admin, ao vivo — substitui a leitura de
    // `adminCommand` no heartbeat de 4s (ver `MediasoupSfuClient.pushCommand`
    // em apps/api). Este socket só recebe o que for endereçado a ESTE peer
    // (ver `peerRoom` em `presence.ts`), então não precisa filtrar por peerId.
    socket.on('moderation:command', (command: PresenceModerationCommand) => {
      if (!this.alive || command.roomSlug !== this.roomId) return;
      this.applyAdminCommand(command);
    });

    socket.on('chat:message', (message: PresenceChatMessage) => {
      if (!this.alive || message.roomSlug !== this.roomId) return;
      for (const listener of this.chatListeners) listener(message.fromPeer, message.displayName, message.body);
    });
  }

  /** Tracks anunciadas antes dos transportes ficarem prontos — drenada assim que `recvTransport`/`device` existem, ver `connect()`. */
  private pendingTracks: PresenceTrackAnnounced[] = [];

  private drainPendingTracks(): void {
    if (this.device === null || this.recvTransport === null || this.pendingTracks.length === 0) return;
    const device = this.device;
    const recvTransport = this.recvTransport;
    const pending = this.pendingTracks;
    this.pendingTracks = [];
    for (const event of pending) {
      if (this.consumedProducerIds.has(event.producerId)) continue;
      this.consumedProducerIds.add(event.producerId);
      void this.consume(recvTransport, device, event.producerId, event.peerId, event.trackKind).catch(() => {
        this.consumedProducerIds.delete(event.producerId);
      });
    }
  }

  /**
   * Obedece um comando de moderação empurrado ao vivo pelo socket de
   * presença (ver `moderation:command` em `connectPresenceSocket`).
   *
   * Cooperativo por natureza (ver docstring de `MediasoupModerationService`
   * no backend): não existe rota do SFU para pausar o producer de OUTRO peer,
   * então o único jeito de "mutar pelo admin" no mediasoup é o alvo mesmo
   * pausar a própria track ao receber o pedido. Idem para mover —
   * `onForceMoved` só entrega o slug; quem troca de sala de fato é
   * `MediasoupRoomShell`/`RoomPage`, do mesmo jeito que já reagem à troca
   * manual de transporte.
   */
  private applyAdminCommand(command: PresenceModerationCommand): void {
    if (command.forceMuted !== undefined && command.forceMuted !== this.lastForceMuted) {
      this.lastForceMuted = command.forceMuted;
      for (const handle of this.localTracks.values()) {
        if (handle.trackKind === 'mic') handle.track.enabled = !command.forceMuted;
      }
      this.events.onForceMuted(command.forceMuted);
    }

    const moveTo = command.moveTo ?? null;
    if (moveTo !== null && moveTo !== this.lastMoveTo) {
      this.lastMoveTo = moveTo;
      this.events.onForceMoved(moveTo);
    } else if (moveTo === null) {
      this.lastMoveTo = null;
    }
  }

  private async consume(
    recvTransport: Transport,
    device: Device,
    producerId: string,
    ownerPeerId: string,
    trackKind: MediasoupTrackKind,
  ): Promise<void> {
    const result = await msConsume(this.roomId, recvTransport.id, {
      peerId: this.peerId,
      producerId,
      rtpCapabilities: device.rtpCapabilities as never,
    });

    const consumer = await recvTransport.consume({
      id: result.id,
      producerId: result.producerId,
      kind: result.kind,
      rtpParameters: result.rtpParameters as never,
    });

    await msResumeConsumer(this.roomId, consumer.id, this.peerId);
    await consumer.resume();

    consumer.on('transportclose', () => {
      this.events.onRemoteTrackEnded(consumer.id);
    });
    consumer.track.addEventListener('ended', () => {
      this.events.onRemoteTrackEnded(consumer.id);
    });

    this.events.onRemoteTrack({
      consumerId: consumer.id,
      producerId: consumer.producerId,
      ownerPeerId,
      kind: consumer.kind,
      trackKind,
      track: consumer.track,
    });
  }
}
