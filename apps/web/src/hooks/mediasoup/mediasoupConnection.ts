import { Device } from 'mediasoup-client';
import type { Producer, Transport } from 'mediasoup-client/types';
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
  private readonly localProducers = new Map<string, Producer>();
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
        if (connState === 'failed') {
          // ICE não achou caminho nenhum até o SFU — o caso mais comum é a
          // faixa de portas de mídia (MEDIASOUP_RTC_MIN_PORT..MAX_PORT)
          // bloqueada antes de chegar na VM (firewall da nuvem, NAT
          // restritivo), não um bug de código: sinalização (HTTP/WSS, porta
          // 443) continua funcionando normalmente nesse caso, então chat e
          // lista de participantes parecem OK enquanto mic/câmera/tela nunca
          // saem do lugar — ver `setup-vm.sh` para as portas exigidas.
          this.events.onError(
            'Não foi possível estabelecer a conexão de áudio/vídeo (rede bloqueando a mídia). O chat de texto continua funcionando.',
          );
        }
        if (connState === 'failed' || connState === 'disconnected') {
          this.setState(connState);
        }
      });

      recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        msConnectTransport(this.roomId, recvTransport.id, { peerId: this.peerId, dtlsParameters })
          .then(() => callback())
          .catch((failure: unknown) => errback(failure as Error));
      });
      recvTransport.on('connectionstatechange', (connState) => {
        if (!this.alive) return;
        if (connState === 'failed') {
          this.events.onError(
            'Não foi possível estabelecer a conexão de áudio/vídeo (rede bloqueando a mídia). O chat de texto continua funcionando.',
          );
        }
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
    this.localProducers.clear();
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

  /**
   * Publica uma track local (mic, câmera ou tela) e devolve o handle.
   *
   * Fecha qualquer producer JÁ existente do mesmo `trackKind` antes de criar
   * o novo — proteção de última linha contra dois cliques rápidos (ligar,
   * desligar, ligar de novo antes do primeiro `produce()` responder) criarem
   * DOIS producers de mic vivos ao mesmo tempo. O sintoma observado era um
   * producer "morto" (0 bytes enviados, nunca avança) ao lado de um vivo — o
   * outro participante podia acabar consumindo o morto (silêncio) em vez do
   * vivo, dependendo de qual `track:announced` chegasse primeiro.
   */
  async publish(track: MediaStreamTrack, trackKind: MediasoupTrackKind): Promise<LocalTrackHandle> {
    const transport = this.sendTransport;
    if (transport === null) {
      throw new Error('Transporte de envio ainda não está pronto.');
    }
    for (const [existingId, existing] of this.localTracks) {
      if (existing.trackKind === trackKind) this.unpublish(existingId);
    }
    // `mediasoup-client` nasce o Producer PAUSADO se `track.enabled` for
    // `false` no instante deste `produce()` (`disableTrackOnPause`, ligado
    // por padrão) — aí ele nunca manda RTP nenhum, mesmo com o resto da
    // conexão (ICE/DTLS, o transporte, o outro lado assinando) funcionando
    // perfeitamente. Uma track recém-saída de `getUserMedia` deveria SEMPRE
    // vir com `enabled: true`, mas nada garante isso de fato (política de
    // mudo do SO/navegador para o site, ou uma reentrância que a desabilitou
    // no meio do caminho) — forçar aqui é barato e elimina de vez essa
    // classe de "mic abre mas não sai áudio nenhum" sem depender de achar a
    // causa exata de `enabled` ter virado `false`.
    track.enabled = true;
    const producer = await transport.produce({
      track,
      appData: { trackKind },
    });
    // Salvaguarda incondicional: mesmo que o Producer tenha nascido pausado
    // por algum motivo (ver comentário acima), garante que ele comece a
    // mandar RTP de verdade.
    if (producer.paused) producer.resume();
    const handle: LocalTrackHandle = {
      producerId: producer.id,
      kind: producer.kind,
      trackKind,
      track,
    };
    this.localTracks.set(producer.id, handle);
    this.localProducers.set(producer.id, producer);
    this.events.onLocalTrackChange([...this.localTracks.values()]);
    return handle;
  }

  /** Encerra uma track local publicada (para de enviar; quem chamou já parou a track de origem). */
  unpublish(producerId: string): void {
    // Sem isto, o `Producer` do lado do cliente (e o producer espelhado no
    // SFU) continuava vivo mesmo depois de "fechar o microfone" — a próxima
    // vez que alguém publicasse mic, o transporte de envio acumulava mais um
    // producer de áudio nunca fechado, e o antigo (mudo, já que a track de
    // origem já tinha sido parada) continuava anunciado para o resto da sala.
    this.localProducers.get(producerId)?.close();
    this.localProducers.delete(producerId);
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
      this.addRosterTrack(event.peerId, event.producerId, event.kind, event.trackKind);
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
      this.removeRosterTrack(event.peerId, event.producerId);
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

  /**
   * Mantém `PeerInfo.mediasoup.tracks` vivo a partir dos eventos de socket
   * `track:announced`/`track:closed`, em vez de depender do heartbeat de 4s
   * que este canal substituiu (ver docstring de `connectPresenceSocket`).
   * Sem isto, `roster:update` só carrega presença pura — nenhum campo do
   * protocolo preenche `mediasoup` de novo — e o resto da sala nunca via o
   * mic/câmera/tela de outro peer acender no `ParticipantSidebar`, mesmo com
   * o áudio/vídeo chegando de verdade (a reprodução em si usa `remoteTracks`,
   * que é outra lista, alimentada direto pelos mesmos eventos).
   */
  private addRosterTrack(
    peerId: string,
    producerId: string,
    kind: 'audio' | 'video',
    trackKind: MediasoupTrackKind,
  ): void {
    const index = this.roster.findIndex((peer) => peer.peerId === peerId);
    if (index === -1) return;
    const peer = this.roster[index]!;
    const tracks = peer.mediasoup?.tracks ?? [];
    if (tracks.some((track) => track.producerId === producerId)) return;
    const nextPeer: PeerInfo = {
      ...peer,
      mediasoup: { tracks: [...tracks, { producerId, kind, trackKind }] },
    };
    this.roster = [...this.roster.slice(0, index), nextPeer, ...this.roster.slice(index + 1)];
    this.events.onRosterChange(this.roster);
  }

  private removeRosterTrack(peerId: string, producerId: string): void {
    const index = this.roster.findIndex((peer) => peer.peerId === peerId);
    if (index === -1) return;
    const peer = this.roster[index]!;
    const tracks = peer.mediasoup?.tracks ?? [];
    if (!tracks.some((track) => track.producerId === producerId)) return;
    const nextPeer: PeerInfo = {
      ...peer,
      mediasoup: { tracks: tracks.filter((track) => track.producerId !== producerId) },
    };
    this.roster = [...this.roster.slice(0, index), nextPeer, ...this.roster.slice(index + 1)];
    this.events.onRosterChange(this.roster);
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
