import { Device } from 'mediasoup-client';
import type { Transport } from 'mediasoup-client/types';
import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerPresenceEvents,
  MediasoupAnnounce,
  MediasoupTrackKind,
  PeerInfo,
  PresenceRosterUpdate,
  ServerToClientPresenceEvents,
} from '@telecord/shared';
import { MEDIASOUP_PUBLIC_URL } from '../../lib/config';
import { peerHeartbeat, peerLeave } from '../../lib/peers';
import {
  fetchMediasoupConfig,
  msConnectTransport,
  msConsume,
  msCreateTransport,
  msLeave,
  msProduce,
  msResumeConsumer,
} from '../../lib/mediasoup';

/**
 * Cadência do anúncio de baixa frequência — NÃO é mais o roster (isso é o
 * socket de presença agora): só existe para publicar `tracks` novas e ler
 * `adminCommand` pendente, dado que essas duas coisas ainda vivem só em
 * `PeerPresence.meta`/`adminCommand` (ver `mediasoup.service.ts`). Mais lento
 * que o antigo TICK_MS de 2.5s porque não precisa mais carregar o roster.
 */
const ANNOUNCE_TICK_MS = 4000;

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
 * (envio/recepção), produtores e consumidores, e o roster do telecord
 * (heartbeat de presença + descoberta de producers).
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
  private announceTimer = 0;
  private presenceSocket: Socket<ServerToClientPresenceEvents, ClientToServerPresenceEvents> | null = null;
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

      this.startAnnounceTick();
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
    window.clearTimeout(this.announceTimer);
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
      // O socket só carrega presença pura (peerId/displayName/joinedAt) — os
      // campos de anúncio de tracks e comando de moderação vêm do heartbeat
      // de baixa cadência (`startAnnounceTick`) e precisam ser preservados
      // ao reconstruir o `PeerInfo[]` que o resto da conexão espera.
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
  }

  /**
   * Anúncio de baixa cadência: publica `tracks` novas e lê `adminCommand`
   * pendente — NÃO é mais o roster (isso é o socket de presença agora, ver
   * `connectPresenceSocket`). Continua chamando `peerHeartbeat` como antes,
   * mas o array `peers` que ele devolve só serve para achar a PRÓPRIA
   * entrada (`adminCommand`) e os `mediasoup.tracks` dos OUTROS, para
   * descobrir producers novos a consumir.
   */
  private startAnnounceTick(): void {
    const announce = async (): Promise<void> => {
      try {
        const tracks = this.localTrackHandles.map((handle) => ({
          producerId: handle.producerId,
          kind: handle.kind,
          trackKind: handle.trackKind,
        }));
        const payload: MediasoupAnnounce | null = tracks.length > 0 ? { tracks } : null;
        const { peers } = await peerHeartbeat(this.roomId, this.peerId, this.displayName, null, payload);
        if (!this.alive) return;
        this.applyAdminCommand(peers);

        const device = this.device;
        const recvTransport = this.recvTransport;
        if (device !== null && recvTransport !== null) {
          for (const peer of peers) {
            if (peer.peerId === this.peerId || peer.mediasoup == null) continue;
            for (const track of peer.mediasoup.tracks) {
              if (this.consumedProducerIds.has(track.producerId)) continue;
              this.consumedProducerIds.add(track.producerId);
              await this.consume(recvTransport, device, track.producerId, peer.peerId, track.trackKind).catch(
                () => {
                  this.consumedProducerIds.delete(track.producerId);
                },
              );
            }
          }
        }
      } catch {
        // Uma falha de anúncio não derruba a mídia já estabelecida.
      } finally {
        if (this.alive) this.announceTimer = window.setTimeout(() => void announce(), ANNOUNCE_TICK_MS);
      }
    };
    void announce();
  }

  /**
   * Obedece o comando de moderação da própria entrada no roster, se houver.
   *
   * Cooperativo por natureza (ver docstring de `MediasoupModerationService`
   * no backend): não existe rota do SFU para pausar o producer de OUTRO peer,
   * então o único jeito de "mutar pelo admin" no mediasoup é o alvo mesmo
   * pausar a própria track ao ler o pedido no heartbeat. Idem para mover —
   * `onForceMoved` só entrega o slug; quem troca de sala de fato é
   * `MediasoupRoomShell`/`RoomPage`, do mesmo jeito que já reagem à troca
   * manual de transporte.
   */
  private applyAdminCommand(peers: PeerInfo[]): void {
    const mine = peers.find((peer) => peer.peerId === this.peerId);
    const command = mine?.adminCommand ?? null;

    const forceMuted = command?.forceMuted === true;
    if (forceMuted !== this.lastForceMuted) {
      this.lastForceMuted = forceMuted;
      for (const handle of this.localTracks.values()) {
        if (handle.trackKind === 'mic') handle.track.enabled = !forceMuted;
      }
      this.events.onForceMuted(forceMuted);
    }

    const moveTo = command?.moveTo ?? null;
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
