import type { Device } from 'mediasoup-client';
import type { ConnectionState, Consumer, Producer, ProducerCodecOptions, Transport } from 'mediasoup-client/types';
import { io, type Socket } from 'socket.io-client';
import {
  SIGNAL_CLOSE,
  type ClientToServerPresenceEvents,
  type MediasoupConsumeResult,
  type MediasoupPublishedTrack,
  type MediasoupTrackKind,
  type MediasoupTransportInfo,
  type PeerInfo,
  type PresenceChatMessage,
  type PresenceModerationCommand,
  type PresenceRosterEntry,
  type PresenceRosterUpdate,
  type PresenceTrackAnnounced,
  type PresenceTrackClosed,
  type ServerToClientPresenceEvents,
  type SignalEventName,
  type SignalEvents,
  type SignalReady,
} from '@telecord/shared';
import { MEDIASOUP_PUBLIC_URL } from '../../lib/config';
import { peerLeave } from '../../lib/peers';
import { DEFAULT_SCREEN_QUALITY, type ScreenQualityId } from '../../lib/media';
import { SignalRequestFailed, SignalStream, SignalUnavailable } from '../../lib/signalStream';
import { SpeakerHold } from '../../lib/speakerHold';
import {
  MIC_CODEC_OPTIONS,
  SCREEN_AUDIO_CODEC_OPTIONS,
  SCREEN_AUDIO_SEND_ENCODING,
  micSendEncoding,
} from './audioProfile';
import { createVoiceDevice } from './voiceDevice';
import { attachVoiceFrameTransform } from '../../lib/voice/frameTransform';
import { DEFAULT_VOICE_BITRATE, type VoiceBitrate } from '../../lib/voice/voiceProfile';
import type { VoiceStatsSource } from '../../components/VoiceDebugPanel';
import {
  CAMERA_CONTENT_HINT,
  CAMERA_DEGRADATION,
  CAMERA_SEND_ENCODING,
  SCREEN_CONTENT_HINT,
  SCREEN_DEGRADATION,
  screenSendEncoding,
} from '../../lib/videoProfile';
import {
  fetchMediasoupConfig,
  msConnectTransport,
  msConsume,
  msCreateTransport,
  msLeave,
  msProduce,
  msResumeConsumer,
} from '../../lib/mediasoup';

export type MediasoupConnectionState =
  | 'new'
  | 'connecting'
  | 'connected'
  /** Já esteve conectado e está voltando sozinho — canal de mídia caído ou caminho de mídia perdido. */
  | 'reconnecting'
  | 'failed'
  | 'disconnected';

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
   * Quem está falando agora, medido pelo SFU no áudio que ele encaminha —
   * inclui o próprio participante. Só chega pelo canal de mídia; no caminho
   * HTTP antigo a lista fica sempre vazia.
   */
  onSpeakersChange: (peerIds: string[]) => void;
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

/** O que a UI pediu para estar no ar. Sobrevive a uma sessão refeita: é daqui que se republica. */
interface Publication {
  trackKind: MediasoupTrackKind;
  track: MediaStreamTrack;
  screenQualityId: ScreenQualityId;
  producer: Producer | null;
  handle: LocalTrackHandle | null;
}

const MEDIA_BLOCKED_MESSAGE =
  'Não foi possível estabelecer a conexão de áudio/vídeo (rede bloqueando a mídia). O chat de texto continua funcionando.';

/**
 * Quanto esperar um transporte "desconectado" se recuperar sozinho antes de
 * renegociar o ICE. O estado é o WebRTC dizendo que perdeu contato, não que
 * desistiu — a maior parte das vezes volta em um ou dois segundos.
 */
const ICE_RESTART_DELAY_MS = 2_000;

/** Depois de renegociar o ICE, quanto esperar antes de desistir do transporte e refazer a sessão. */
const ICE_RECOVERY_TIMEOUT_MS = 12_000;

/** Entre uma tentativa frustrada de refazer a sessão e a próxima. */
const REBUILD_RETRY_MS = 2_000;

const CONSUME_RETRY_MS = 1_000;

/**
 * Conexão de baixo nível com o SFU mediasoup: Device, os dois `Transport`s
 * (envio/recepção), produtores e consumidores, e o roster do telecord.
 *
 * ## Dois canais, direto com o nó
 *
 * - **presença** (Socket.IO, `connectPresenceSocket`): roster, chat e
 *   moderação — o que é de sala.
 * - **mídia** (`SignalStream`): criar transporte, publicar, assinar. É o
 *   desenho do Discord e do Meet: `apps/api` autoriza a entrada UMA vez
 *   (`fetchMediasoupConfig`) e sai do caminho; daí em diante ligar o
 *   microfone ou abrir a tela é uma conversa com o mesmo processo que
 *   encaminha os pacotes, sem função serverless nem banco no meio.
 *
 * Quando o canal de mídia não abre (SFU de uma versão anterior, rede que
 * barra WebSocket), a conexão cai no caminho ANTIGO: as mesmas operações por
 * HTTP, através do proxy `/api/mediasoup/*`. Funciona como sempre funcionou,
 * sem o que só o canal oferece — retomada, quem está falando, parar de
 * assistir.
 *
 * ## Voltar sozinho
 *
 * Com o canal de mídia, uma queda não é mais o fim da sala:
 *
 * - o canal caiu e voltou a tempo → o servidor ainda tem a sessão, e tudo
 *   continua como estava (`reconcile`);
 * - a sessão se perdeu (o SFU reiniciou num deploy, a folga venceu) → os
 *   transportes são refeitos e o que estava no ar é republicado (`rebuild`);
 * - só o caminho da mídia caiu (trocou de Wi-Fi) → o ICE é renegociado no
 *   mesmo transporte.
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
  /** `null` = caminho HTTP antigo. */
  private signal: SignalStream | null = null;
  /** A sessão de mídia que o servidor nos deu — ver `SignalReady.sessionId`. */
  private sessionId: string | null = null;
  /** Sobe a cada sessão montada: quem estava no meio de montar a anterior percebe e desiste. */
  private sessionEpoch = 0;
  private nodeUrl = MEDIASOUP_PUBLIC_URL;
  /** O token de entrada mais recente assinado por `apps/api`. */
  private token = '';
  /**
   * Identifica ESTA página nos dois canais. Sair de uma sala e entrar de novo
   * em seguida cria outra conexão com o mesmo `peerId`; é este valor que
   * impede a despedida da antiga de derrubar a nova no servidor.
   */
  private readonly instanceId: string = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);

  private readonly publications = new Map<MediasoupTrackKind, Publication>();
  /** Tracks dos OUTROS que estão no ar agora, por `producerId`. */
  private readonly announced = new Map<string, PresenceTrackAnnounced>();
  /** Consumers por `producerId` — uma track remota, uma assinatura. */
  private readonly consumers = new Map<string, Consumer>();
  private readonly consuming = new Set<string>();
  /**
   * A mídia já fluiu alguma vez NESTA página. Separa os dois motivos de um
   * transporte falhar: nunca ter funcionado (a porta de mídia está bloqueada,
   * e insistir não muda nada) de ter parado de funcionar (a rede caiu, e
   * volta).
   */
  private mediaEverConnected = false;
  private readonly iceTimers = new Map<Transport, ReturnType<typeof setTimeout>>();

  private presenceEntries: PresenceRosterEntry[] = [];
  private roster: PeerInfo[] = [];
  private state: MediasoupConnectionState = 'new';
  private presenceSocket: Socket<ServerToClientPresenceEvents, ClientToServerPresenceEvents> | null = null;
  private presenceRetries = 0;
  private readonly speakerHold: SpeakerHold;
  /**
   * Ouvintes de chat, à parte de `MediasoupConnectionEvents` (que tem UM dono
   * só, `useMediasoupEngine`) — `useMediasoupChat` é montado DEPOIS do
   * engine e precisa se inscrever na conexão já criada, não no construtor
   * dela. `Set` porque não há por que limitar a um só (StrictMode monta o
   * hook duas vezes em dev, por exemplo) nem duplicar entrega.
   */
  private readonly chatListeners = new Set<(fromPeer: string, displayName: string, body: string) => void>();
  private alive = true;
  /** Evita disparar `onForceMuted`/`onForceMoved` de novo enquanto o comando continuar o mesmo. */
  private lastForceMuted = false;
  private lastMoveTo: string | null = null;
  /** Teto do microfone nesta sala — ver `setVoiceBitrate`. */
  private voiceBitrate: VoiceBitrate = DEFAULT_VOICE_BITRATE;

  constructor(
    private readonly roomId: string,
    private readonly peerId: string,
    private readonly displayName: string,
    private readonly events: MediasoupConnectionEvents,
  ) {
    this.speakerHold = new SpeakerHold((peerIds) => {
      if (this.alive) this.events.onSpeakersChange(peerIds);
    });
  }

  async connect(): Promise<void> {
    this.setState('connecting');
    try {
      /*
       * A única ida a `apps/api` de toda a entrada. Devolve o token que abre
       * os dois canais do SFU e, quando há mais de um nó, QUAL deles é o
       * desta sala. O heartbeat que ela faz do lado do servidor (ver
       * `MediasoupService.clientConfig`) é o que mantém o caminho HTTP antigo
       * utilizável, se for preciso cair nele.
       */
      const config = await fetchMediasoupConfig(this.roomId, this.peerId, this.displayName);
      if (!this.alive) return;
      if (!config.enabled || config.presenceToken === null) {
        this.events.onError('O mediasoup não está configurado neste servidor.');
        this.setState('failed');
        return;
      }
      this.token = config.presenceToken;
      this.nodeUrl = (config.node?.url ?? MEDIASOUP_PUBLIC_URL).replace(/\/$/, '');

      // Com a política de SDP da voz (Opus só, fmtp do Discord) — ver `voiceDevice.ts`.
      const device = createVoiceDevice();
      await device.load({ routerRtpCapabilities: config.routerRtpCapabilities as never });
      if (!this.alive) return;
      this.device = device;

      this.connectPresenceSocket();

      const ready = await this.openSignal();
      if (!this.alive) return;
      if (ready !== null) await this.startSession(ready);
      else await this.createTransports(this.sessionEpoch);
      if (!this.alive) return;

      // A UI libera assim que os dois transportes existem — não espera o
      // handshake DTLS, que só ocorre ao publicar/assinar algo.
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
    this.speakerHold.clear();
    const usedHttp = this.signal === null;
    this.presenceSocket?.disconnect();
    this.presenceSocket = null;
    // Fechado com 1000: é o que o SFU lê como despedida e o faz tirar este
    // par da sala na hora, sem esperar a folga de reconexão.
    this.signal?.close();
    this.signal = null;
    this.releaseMedia(true);
    this.device = null;
    this.announced.clear();
    /*
     * `msLeave` só no caminho HTTP, onde não há canal para se despedir. Com
     * o canal de mídia ele seria pior que inútil: a chamada atravessa a
     * função serverless e pode chegar DEPOIS de a pessoa ter entrado de novo
     * na mesma sala — derrubando a sessão nova em nome da antiga.
     * `peerLeave` continua limpando a linha `PeerPresence` no Prisma, que
     * nenhum dos canais toca.
     */
    if (usedHttp) void msLeave(this.roomId, this.peerId).catch(() => undefined);
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
   * Fecha qualquer publicação JÁ existente do mesmo `trackKind` antes de
   * criar a nova — proteção de última linha contra dois cliques rápidos
   * (ligar, desligar, ligar de novo antes do primeiro `produce()` responder)
   * criarem DOIS producers de mic vivos ao mesmo tempo. O SFU impõe a mesma
   * regra do lado dele (ver `RoomRegistry.produce`).
   */
  async publish(
    track: MediaStreamTrack,
    trackKind: MediasoupTrackKind,
    /** Nível escolhido na UI — só usado por `screen-video`, ver `videoProfile.ts`. */
    screenQualityId: ScreenQualityId = DEFAULT_SCREEN_QUALITY,
  ): Promise<LocalTrackHandle> {
    if (this.sendTransport === null) {
      throw new Error('Transporte de envio ainda não está pronto.');
    }
    const previous = this.publications.get(trackKind);
    if (previous !== undefined) {
      this.publications.delete(trackKind);
      this.retirePublication(previous, previous.track !== track);
    }

    const publication: Publication = { trackKind, track, screenQualityId, producer: null, handle: null };
    this.publications.set(trackKind, publication);
    try {
      await this.produceFor(publication);
    } catch (error) {
      if (this.publications.get(trackKind) === publication) this.publications.delete(trackKind);
      throw error;
    }
    if (publication.handle === null) throw new Error('A publicação foi cancelada.');
    return publication.handle;
  }

  /** Encerra uma track local publicada — aqui e no SFU, que avisa quem assistia na hora. */
  unpublish(producerId: string): void {
    for (const [trackKind, publication] of this.publications) {
      if (publication.handle?.producerId !== producerId) continue;
      this.publications.delete(trackKind);
      this.retirePublication(publication, true);
      this.emitLocalTracks();
      return;
    }
  }

  /**
   * Troca a track de uma publicação no ar sem renegociar (`replaceTrack`).
   * É o caminho da troca de microfone, da supressão de ruído e do
   * cancelamento de eco: a captura nova entra no MESMO producer, e quem ouve
   * não percebe nada além de um corte de milissegundos.
   *
   * A track antiga continua sendo de quem a capturou — parar é com ele.
   * `false` quando não há publicação daquele tipo no ar.
   */
  async replaceTrack(trackKind: MediasoupTrackKind, track: MediaStreamTrack): Promise<boolean> {
    const publication = this.publications.get(trackKind);
    if (publication === undefined) return false;
    track.enabled = !(trackKind === 'mic' && this.lastForceMuted);
    publication.track = track;
    const producer = publication.producer;
    if (producer !== null && !producer.closed) {
      await producer.replaceTrack({ track });
    }
    if (publication.handle !== null) publication.handle = { ...publication.handle, track };
    this.emitLocalTracks();
    return true;
  }

  /** Teto do microfone. Vale na hora para o que está no ar e para a próxima publicação. */
  setVoiceBitrate(bitrate: VoiceBitrate): void {
    this.voiceBitrate = bitrate;
    const producer = this.publications.get('mic')?.producer ?? null;
    if (producer !== null && !producer.closed) {
      void this.forceSendParameters(producer.rtpSender ?? null, micSendEncoding(bitrate), null);
    }
  }

  /** Para o painel de debug: o microfone e cada voz/áudio de tela que chega. */
  getVoiceStatsSources(): VoiceStatsSource[] {
    const sources: VoiceStatsSource[] = [];
    const mic = this.publications.get('mic')?.producer ?? null;
    if (mic !== null && !mic.closed) {
      sources.push({ id: 'local-mic', label: 'Você · microfone', direction: 'send', getStats: () => mic.getStats() });
    }
    const names = new Map(this.roster.map((peer) => [peer.peerId, peer.displayName]));
    for (const [producerId, consumer] of this.consumers) {
      if (consumer.closed || consumer.kind !== 'audio') continue;
      const track = this.announced.get(producerId);
      const owner = track === undefined ? 'alguém' : (names.get(track.peerId) ?? track.peerId);
      sources.push({
        id: consumer.id,
        label: `${owner}${track?.trackKind === 'screen-audio' ? ' · áudio da tela' : ''}`,
        direction: 'recv',
        getStats: () => consumer.getStats(),
      });
    }
    return sources;
  }

  get localTrackHandles(): LocalTrackHandle[] {
    return [...this.publications.values()].flatMap((publication) =>
      publication.handle === null ? [] : [publication.handle],
    );
  }

  /** `true` quando dá para pedir ao SFU que pare de MANDAR uma track — só existe no canal de mídia. */
  get canPauseRemoteTracks(): boolean {
    return this.signal !== null;
  }

  /**
   * Para (ou retoma) o envio de uma track remota a ESTE navegador.
   *
   * É o "parar de assistir" de uma tela: o SFU deixa de encaminhar os pacotes,
   * que é a única forma de aliviar a banda de verdade — esconder o vídeo com
   * CSS continuaria baixando tudo.
   */
  async setRemoteTrackPaused(consumerId: string, paused: boolean): Promise<void> {
    const signal = this.signal;
    if (signal === null) return;
    const consumer = [...this.consumers.values()].find((entry) => entry.id === consumerId);
    if (consumer === undefined || consumer.closed) return;
    await signal.request(paused ? 'pauseConsumer' : 'resumeConsumer', { consumerId });
    if (consumer.closed) return;
    if (paused) consumer.pause();
    else consumer.resume();
  }

  /**
   * Manda uma mensagem de chat/soundboard pelo socket de presença — substitui
   * o polling de `RoomBroadcastMessage` (`msPollBroadcast`/`msSendBroadcast`).
   * Sem persistência aqui: quem entra depois não recebe histórico, mesma
   * regra que já valia (ver `pollBroadcast` em `mediasoup.service.ts`).
   * Fire-and-forget: se o socket ainda não abriu, a mensagem se perde — não
   * há fila.
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
    if (this.state === state) return;
    this.state = state;
    this.events.onStateChange(state);
  }

  // -------------------------------------------------------------------------
  // Canal de mídia
  // -------------------------------------------------------------------------

  /**
   * Abre o canal de mídia. `null` quer dizer que ele não está disponível e a
   * conexão segue pelo caminho HTTP.
   */
  private async openSignal(): Promise<SignalReady | null> {
    const signal = new SignalStream({
      nodeUrl: this.nodeUrl,
      getToken: (fresh) => this.obtainToken(fresh),
      getSessionId: () => this.sessionId,
      instanceId: this.instanceId,
      onReady: (ready, reconnected) => {
        if (!this.alive || this.signal !== signal) return;
        // Síncrono: o retrato da sala entra antes de qualquer evento que
        // venha depois dele.
        this.applySnapshot(ready);
        if (reconnected) void this.handleReconnected(ready);
      },
      onEvent: (name, data) => {
        if (this.alive && this.signal === signal) this.handleSignalEvent(name, data);
      },
      onStateChange: (state) => {
        if (this.alive && this.signal === signal && state === 'reconnecting') this.setState('reconnecting');
      },
      onFinalClose: (code) => {
        if (this.signal === signal) this.handleFinalClose(code);
      },
    });
    this.signal = signal;
    try {
      return await signal.start();
    } catch (error) {
      if (this.signal === signal) this.signal = null;
      if (error instanceof SignalUnavailable) return null;
      throw error;
    }
  }

  /** Um token para os canais do SFU. `fresh` volta a `apps/api` — o único caso em que ela reentra no caminho. */
  private async obtainToken(fresh: boolean): Promise<string> {
    if (!fresh) return this.token;
    const config = await fetchMediasoupConfig(this.roomId, this.peerId, this.displayName);
    if (!config.enabled || config.presenceToken === null) {
      throw new Error('O mediasoup deixou de estar configurado neste servidor.');
    }
    const nodeUrl = (config.node?.url ?? MEDIASOUP_PUBLIC_URL).replace(/\/$/, '');
    if (nodeUrl !== this.nodeUrl) {
      // A sala passou a morar em outro nó. Os canais desta conexão apontam
      // para o antigo; insistir nele seria reconectar a uma sala vazia.
      this.events.onError('O servidor desta sala mudou. Entre de novo para continuar.');
      this.handleFinalClose(null);
      throw new Error('A sala mudou de nó.');
    }
    this.token = config.presenceToken;
    return this.token;
  }

  /** Monta a sessão de mídia do zero: capabilities, os dois transportes e o que estava no ar. */
  private async startSession(ready: SignalReady): Promise<void> {
    const signal = this.signal;
    const device = this.device;
    if (signal === null || device === null) return;
    const epoch = (this.sessionEpoch += 1);
    this.sessionId = ready.sessionId;

    // Uma vez por sessão, em vez de ~10 KB a cada `consume`.
    await signal.request('setRtpCapabilities', { rtpCapabilities: device.rtpCapabilities });
    if (!this.isCurrent(epoch)) return;
    await this.createTransports(epoch);
    if (!this.isCurrent(epoch)) return;
    await this.republishAll(epoch);
  }

  private isCurrent(epoch: number): boolean {
    return this.alive && this.sessionEpoch === epoch;
  }

  /**
   * O canal voltou. O `ready` diz o que o servidor ainda tem deste par, e é
   * isso — não o que aconteceu enquanto estávamos fora — que decide o que
   * fazer. Mesma regra do resto do app: depois de uma reconexão, re-derivar
   * do estado, sem confiar em evento que pode ter se perdido.
   */
  private async handleReconnected(ready: SignalReady): Promise<void> {
    const send = this.sendTransport;
    const recv = this.recvTransport;
    const intact =
      ready.sessionId === this.sessionId &&
      send !== null &&
      recv !== null &&
      !send.closed &&
      !recv.closed &&
      ready.transportIds.includes(send.id) &&
      ready.transportIds.includes(recv.id);

    try {
      if (intact) {
        await this.reconcile(ready);
      } else {
        this.releaseMedia(false);
        await this.startSession(ready);
      }
    } catch {
      // A sessão ficou pela metade. Nova volta do canal, novo `ready`.
      if (this.alive) setTimeout(() => this.forceRebuild(), REBUILD_RETRY_MS);
      return;
    }
    if (this.alive && this.signal?.currentState === 'ready' && this.transportsHealthy()) {
      this.setState('connected');
    }
  }

  /** A sessão sobreviveu. Só acerta o que mudou enquanto o canal estava fora. */
  private async reconcile(ready: SignalReady): Promise<void> {
    const epoch = this.sessionEpoch;
    const serverConsumers = new Set(ready.consumerIds);
    for (const [producerId, consumer] of [...this.consumers]) {
      // Fechado lá e ainda aberto aqui: derruba e deixa `consumeMissing`
      // assinar de novo, se a track continuar no ar.
      if (!serverConsumers.has(consumer.id)) this.dropConsumer(producerId, consumer);
    }

    const serverProducers = new Set(ready.producerIds);
    for (const publication of [...this.publications.values()]) {
      const producer = publication.producer;
      if (producer === null || serverProducers.has(producer.id)) continue;
      producer.close();
      publication.producer = null;
      if (!this.isCurrent(epoch)) return;
      await this.republish(publication, epoch);
    }
    this.consumeMissing();
  }

  /**
   * Joga fora a sessão que o cliente acha que tem e pede outra. Usado quando
   * renegociar o ICE não resolveu, ou quando o servidor diz não conhecer um
   * transporte que aqui ainda existe.
   */
  private forceRebuild(): void {
    if (!this.alive || this.signal === null) return;
    this.sessionId = null;
    this.signal.restart();
  }

  /**
   * O servidor encerrou de vez: a mesma pessoa abriu a sala em outra aba, a
   * moderação a removeu, ou a sala mudou de nó (`code === null`). Voltar
   * sozinho seria errado nos três casos.
   */
  private handleFinalClose(code: number | null): void {
    if (!this.alive) return;
    this.alive = false;
    if (code === SIGNAL_CLOSE.removed) {
      this.events.onError('Um administrador removeu você desta sala.');
    } else if (code === SIGNAL_CLOSE.replaced) {
      this.events.onError('Esta sala foi aberta em outra aba ou dispositivo. Esta janela foi desconectada.');
    }
    this.speakerHold.clear();
    this.events.onSpeakersChange([]);
    this.presenceSocket?.disconnect();
    this.presenceSocket = null;
    this.signal?.close();
    this.releaseMedia(true);
    this.setState('disconnected');
  }

  private handleSignalEvent<E extends SignalEventName>(name: E, data: SignalEvents[E]): void {
    switch (name) {
      case 'track:announced':
        this.trackAnnounced(data as SignalEvents['track:announced']);
        break;
      case 'track:closed':
        this.trackClosed(data as SignalEvents['track:closed']);
        break;
      case 'consumer:closed': {
        // A track continua no ar; o que caiu foi a ponte entre dois Workers
        // do SFU. Derruba o consumer morto e assina de novo.
        const { consumerId, producerId } = data as SignalEvents['consumer:closed'];
        const consumer = this.consumers.get(producerId);
        if (consumer !== undefined && consumer.id === consumerId) this.dropConsumer(producerId, consumer);
        const track = this.announced.get(producerId);
        if (track !== undefined) this.ensureConsumed(track);
        break;
      }
      case 'speakers':
        this.speakerHold.update((data as SignalEvents['speakers']).speakers.map((speaker) => speaker.peerId));
        break;
      default:
        // Evento de uma versão mais nova do protocolo: ignorar é o certo.
        break;
    }
  }

  /** O retrato da sala que veio no `ready`: substitui o que se sabia, em vez de somar. */
  private applySnapshot(ready: SignalReady): void {
    const next = new Map(ready.tracks.map((track) => [track.producerId, track]));
    for (const [producerId, consumer] of [...this.consumers]) {
      if (!next.has(producerId)) this.dropConsumer(producerId, consumer);
    }
    this.announced.clear();
    for (const [producerId, track] of next) this.announced.set(producerId, track);
    this.rebuildRoster();
    this.speakerHold.update(ready.speakers.map((speaker) => speaker.peerId));
  }

  // -------------------------------------------------------------------------
  // Transportes
  // -------------------------------------------------------------------------

  private async createTransports(epoch: number): Promise<void> {
    const device = this.device;
    if (device === null) throw new Error('Device ainda não carregado.');

    let sendInfo: MediasoupTransportInfo;
    let recvInfo: MediasoupTransportInfo;
    if (this.signal !== null) {
      // Pelo canal de mídia os dois pedidos saem juntos: uma ida e volta.
      [sendInfo, recvInfo] = await Promise.all([this.rpcCreateTransport('send'), this.rpcCreateTransport('recv')]);
    } else {
      sendInfo = await this.rpcCreateTransport('send');
      recvInfo = await this.rpcCreateTransport('recv');
    }
    if (!this.isCurrent(epoch)) return;

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

    this.wireTransport(sendTransport, 'send');
    this.wireTransport(recvTransport, 'recv');
    sendTransport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
      const trackKind = (appData as { trackKind?: MediasoupTrackKind }).trackKind ?? 'mic';
      this.rpcProduce(sendTransport.id, kind, rtpParameters, trackKind)
        .then((producerId) => callback({ id: producerId }))
        .catch((failure: unknown) => errback(failure as Error));
    });

    this.sendTransport = sendTransport;
    this.recvTransport = recvTransport;
    this.consumeMissing();
  }

  private wireTransport(transport: Transport, direction: 'send' | 'recv'): void {
    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.rpcConnectTransport(transport.id, dtlsParameters)
        .then(() => callback())
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
    transport.on('connectionstatechange', (connState) => {
      this.handleTransportState(transport, direction, connState);
    });
  }

  private handleTransportState(transport: Transport, direction: 'send' | 'recv', connState: ConnectionState): void {
    if (!this.alive) return;
    // Transporte de uma sessão que já foi refeita: o que acontece com ele não
    // diz mais nada sobre a conexão.
    if ((direction === 'send' ? this.sendTransport : this.recvTransport) !== transport) return;

    if (connState === 'connected') {
      this.mediaEverConnected = true;
      this.cancelIceRestart(transport);
      if (this.state === 'reconnecting' && this.signal?.currentState === 'ready' && this.transportsHealthy()) {
        this.setState('connected');
      }
      return;
    }
    if (connState !== 'failed' && connState !== 'disconnected') return;

    /*
     * Já funcionou e parou: a rede mudou (trocou de Wi-Fi, o cabo saiu).
     * Com o canal de mídia dá para renegociar o caminho sem refazer nada —
     * os producers e consumers continuam os mesmos. Vale também para um
     * transporte recém-refeito que ainda não conectou: se a mídia já fluiu
     * nesta página, o problema é a rede de agora, não a porta.
     */
    if (this.mediaEverConnected && this.signal !== null) {
      this.setState('reconnecting');
      this.scheduleIceRestart(transport, connState === 'failed' ? 0 : ICE_RESTART_DELAY_MS);
      return;
    }

    if (connState === 'failed') {
      // ICE não achou caminho nenhum até o SFU — o caso mais comum é a
      // porta de mídia bloqueada antes de chegar na VM (firewall da nuvem,
      // NAT restritivo), não um bug de código: sinalização (porta 443)
      // continua funcionando normalmente nesse caso, então chat e lista de
      // participantes parecem OK enquanto mic/câmera/tela nunca saem do
      // lugar — ver `setup-vm.sh` para as portas exigidas.
      this.events.onError(MEDIA_BLOCKED_MESSAGE);
    }
    if (direction === 'send') this.setState(connState);
  }

  /** `true` quando nenhum dos dois transportes está no meio de uma queda. */
  private transportsHealthy(): boolean {
    for (const transport of [this.sendTransport, this.recvTransport]) {
      if (transport === null) return false;
      const connState = transport.connectionState;
      if (connState === 'failed' || connState === 'disconnected' || connState === 'closed') return false;
    }
    return true;
  }

  private scheduleIceRestart(transport: Transport, delayMs: number): void {
    if (this.iceTimers.has(transport)) return;
    this.iceTimers.set(
      transport,
      setTimeout(() => {
        this.iceTimers.delete(transport);
        void this.restartIce(transport);
      }, delayMs),
    );
  }

  private cancelIceRestart(transport: Transport): void {
    const timer = this.iceTimers.get(transport);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.iceTimers.delete(transport);
  }

  private async restartIce(transport: Transport): Promise<void> {
    const signal = this.signal;
    if (!this.alive || signal === null || transport.closed || transport.connectionState === 'connected') return;
    try {
      const { iceParameters } = await signal.request('restartIce', { transportId: transport.id });
      if (transport.closed) return;
      await transport.restartIce({ iceParameters: iceParameters as never });
    } catch (error) {
      // O servidor não conhece mais este transporte: a sessão se perdeu sem
      // o canal ter caído. Só refazendo.
      if (error instanceof SignalRequestFailed && error.code === 'not_found') {
        this.forceRebuild();
        return;
      }
    }
    // Renegociado. Se mesmo assim o transporte não voltar, ele não volta.
    this.iceTimers.set(
      transport,
      setTimeout(() => {
        this.iceTimers.delete(transport);
        const current = transport === this.sendTransport || transport === this.recvTransport;
        if (this.alive && current && !transport.closed && transport.connectionState !== 'connected') {
          this.forceRebuild();
        }
      }, ICE_RECOVERY_TIMEOUT_MS),
    );
  }

  /**
   * Solta transportes, producers e consumers.
   *
   * `stopTracks` distingue os dois usos: ao SAIR da sala as tracks locais
   * são paradas (o microfone e a captura de tela não podem continuar acesos);
   * ao REFAZER a sessão elas ficam vivas, porque vão ser republicadas.
   */
  private releaseMedia(stopTracks: boolean): void {
    for (const timer of this.iceTimers.values()) clearTimeout(timer);
    this.iceTimers.clear();

    for (const [producerId, consumer] of [...this.consumers]) this.dropConsumer(producerId, consumer);
    this.consuming.clear();

    for (const publication of this.publications.values()) {
      publication.producer?.close();
      publication.producer = null;
      if (stopTracks) publication.track.stop();
    }
    if (stopTracks) {
      this.publications.clear();
      this.emitLocalTracks();
    }

    // As referências caem ANTES do `close()`: os ouvintes de estado dos
    // transportes conferem se ainda são os atuais, e estes já não são.
    const send = this.sendTransport;
    const recv = this.recvTransport;
    this.sendTransport = null;
    this.recvTransport = null;
    send?.close();
    recv?.close();
  }

  // -------------------------------------------------------------------------
  // Publicar
  // -------------------------------------------------------------------------

  private async produceFor(publication: Publication): Promise<void> {
    const transport = this.sendTransport;
    if (transport === null) throw new Error('Transporte de envio ainda não está pronto.');
    const { track, trackKind } = publication;

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

    /*
     * Perfil de qualidade por tipo de track — ver `audioProfile.ts` e
     * `videoProfile.ts` para o porquê de cada número. Sem isto, tudo cai no
     * preset de videoconferência do navegador (~32 kbps de voz, ~2.5 Mbps de
     * tela), por mais alto que seja o teto anunciado pelo codec.
     *
     * `contentHint` é aplicado na TRACK (não no producer): é o que diz ao
     * codificador o que sacrificar sob pressão — detalhe ou fluidez.
     */
    let profile: {
      codecOptions?: ProducerCodecOptions;
      encodings?: RTCRtpEncodingParameters[];
    } | null = null;
    let degradation: RTCDegradationPreference | null = null;

    if (trackKind === 'mic') {
      profile = { codecOptions: MIC_CODEC_OPTIONS, encodings: [micSendEncoding(this.voiceBitrate)] };
    } else if (trackKind === 'screen-audio') {
      profile = { codecOptions: SCREEN_AUDIO_CODEC_OPTIONS, encodings: [SCREEN_AUDIO_SEND_ENCODING] };
    } else if (trackKind === 'screen-video') {
      track.contentHint = SCREEN_CONTENT_HINT;
      profile = { encodings: [screenSendEncoding(publication.screenQualityId)] };
      degradation = SCREEN_DEGRADATION;
    } else if (trackKind === 'camera') {
      track.contentHint = CAMERA_CONTENT_HINT;
      profile = { encodings: [CAMERA_SEND_ENCODING] };
      degradation = CAMERA_DEGRADATION;
    }

    const producer = await transport.produce({
      track,
      appData: { trackKind },
      /*
       * A track NÃO é do producer. Com o padrão (`true`) o mediasoup-client
       * a pararia junto com o transporte — e refazer a sessão depois de uma
       * queda exigiria pedir o microfone e a tela de novo à pessoa. Quem
       * para a track é quem sabe que ela acabou: `unpublish` e `close`.
       */
      stopTracks: false,
      ...(profile ?? {}),
    });

    // Enquanto o `produce` esperava a rede, quem pediu pode ter desistido, e
    // a sessão pode ter sido refeita por cima.
    if (this.publications.get(trackKind) !== publication || this.sendTransport !== transport) {
      producer.close();
      this.closeServerProducer(producer.id);
      throw new Error('A publicação foi cancelada.');
    }

    // Salvaguarda incondicional: mesmo que o Producer tenha nascido pausado
    // por algum motivo (ver comentário acima), garante que ele comece a
    // mandar RTP de verdade.
    if (producer.paused) producer.resume();
    // `encodings` no `produce()` cobre o caso normal, mas o Chrome às vezes
    // ignora o `maxBitrate` inicial do sender e cai no preset dele. Reaplicar
    // via `setParameters()` logo depois é o caminho que pega nos dois casos —
    // sem isto, todo o resto do perfil (fmtp do codec, captura em alta) fica
    // preso num teto baixo e não adianta nada.
    const encoding = profile?.encodings?.[0];
    if (encoding !== undefined) {
      void this.forceSendParameters(producer.rtpSender ?? null, encoding, degradation);
    }
    // Republicado no meio de um mudo forçado pela moderação: continua mudo.
    if (trackKind === 'mic' && this.lastForceMuted) track.enabled = false;
    // Gancho de E2EE por quadro (desligado por padrão).
    if ((trackKind === 'mic' || trackKind === 'screen-audio') && producer.rtpSender !== undefined) {
      attachVoiceFrameTransform(producer.rtpSender, { direction: 'send', trackKind, peerId: this.peerId });
    }

    publication.producer = producer;
    publication.handle = { producerId: producer.id, kind: producer.kind, trackKind, track };
    this.emitLocalTracks();
  }

  /** Depois de uma sessão refeita: põe de volta no ar o que a UI tinha pedido. */
  private async republishAll(epoch: number): Promise<void> {
    for (const publication of [...this.publications.values()]) {
      if (!this.isCurrent(epoch)) return;
      await this.republish(publication, epoch);
    }
    this.emitLocalTracks();
  }

  /**
   * Republica UMA track na sessão atual. Duas tentativas; se nenhuma der
   * certo a publicação é desfeita de verdade — track parada, UI avisada.
   * Deixar a entrada lá sem producer seria o pior resultado possível: o
   * botão mostrando o microfone aberto e ninguém ouvindo.
   */
  private async republish(publication: Publication, epoch: number): Promise<void> {
    const stillWanted = (): boolean => this.publications.get(publication.trackKind) === publication;
    // A captura acabou enquanto estávamos fora (a pessoa parou de
    // compartilhar pelo botão do navegador): não há o que republicar.
    if (publication.track.readyState === 'live') {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!this.isCurrent(epoch) || !stillWanted()) return;
        try {
          await this.produceFor(publication);
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      if (!this.isCurrent(epoch) || !stillWanted()) return;
      this.events.onError('Não foi possível retomar uma transmissão depois da reconexão. Ligue de novo.');
    }
    if (!stillWanted()) return;
    this.publications.delete(publication.trackKind);
    publication.track.stop();
    this.emitLocalTracks();
  }

  private retirePublication(publication: Publication, stopTrack: boolean): void {
    const producer = publication.producer;
    publication.producer = null;
    if (producer !== null) {
      producer.close();
      this.closeServerProducer(producer.id);
    }
    if (stopTrack) publication.track.stop();
  }

  /**
   * Avisa o SFU de que a track saiu do ar.
   *
   * Sem este aviso o producer continuava vivo no servidor até a pessoa sair
   * da sala: quem assistia ficava com a tela congelada no último quadro, e
   * cada vez que alguém soltava o "aperte para falar" sobrava um producer
   * morto lá e um consumer morto em cada ouvinte. Só existe no canal de
   * mídia — o caminho HTTP nunca teve essa rota.
   */
  private closeServerProducer(producerId: string): void {
    void this.signal?.request('closeProducer', { producerId }).catch(() => undefined);
  }

  private emitLocalTracks(): void {
    this.events.onLocalTrackChange(this.localTrackHandles);
  }

  /**
   * Reaplica teto de bitrate (e, para vídeo, a preferência de degradação) no
   * `RTCRtpSender`.
   *
   * O `encodings` passado ao `produce()` deveria bastar, mas o Chrome
   * frequentemente ignora `maxBitrate` em senders criados por `addTrack` (o
   * caminho que o mediasoup-client usa) e mantém o preset interno dele.
   * `setParameters()` depois do sender existir é o que efetivamente vale — é
   * assim que o próprio livekit-client aplica os presets dele.
   */
  private async forceSendParameters(
    sender: RTCRtpSender | null,
    encoding: RTCRtpEncodingParameters,
    degradation: RTCDegradationPreference | null,
  ): Promise<void> {
    if (sender === null) return;
    try {
      const params = sender.getParameters();
      // `getParameters()` pode vir sem `encodings` antes da negociação
      // terminar; criar a entrada na mão é o que a própria spec recomenda.
      if (params.encodings === undefined || params.encodings.length === 0) {
        params.encodings = [{ ...encoding }];
      } else {
        params.encodings = params.encodings.map((current) => ({ ...current, ...encoding }));
      }
      if (degradation !== null) params.degradationPreference = degradation;
      await sender.setParameters(params);
    } catch {
      // Navegador que recusa `setParameters` continua no preset dele —
      // qualidade menor, não quebra nada. Não vale derrubar a publicação
      // por causa disto.
    }
  }

  // -------------------------------------------------------------------------
  // Assinar
  // -------------------------------------------------------------------------

  private trackAnnounced(event: PresenceTrackAnnounced): void {
    if (event.roomSlug !== this.roomId || event.peerId === this.peerId) return;
    this.announced.set(event.producerId, event);
    this.rebuildRoster();
    this.ensureConsumed(event);
  }

  private trackClosed(event: PresenceTrackClosed): void {
    if (event.roomSlug !== this.roomId) return;
    if (!this.announced.delete(event.producerId)) return;
    // A track saiu do ar: o consumer daqui vai junto, e é isso que tira o
    // quadro do palco em vez de deixá-lo congelado no último frame.
    const consumer = this.consumers.get(event.producerId);
    if (consumer !== undefined) this.dropConsumer(event.producerId, consumer);
    this.rebuildRoster();
  }

  /** Assina tudo o que está no ar e ainda não foi assinado — chamado sempre que os transportes (re)aparecem. */
  private consumeMissing(): void {
    for (const track of this.announced.values()) this.ensureConsumed(track);
  }

  private ensureConsumed(track: PresenceTrackAnnounced, isRetry = false): void {
    const recvTransport = this.recvTransport;
    // Sem transporte ainda (o anúncio chegou antes de a sessão ficar
    // pronta): `consumeMissing` passa de novo quando ele existir.
    if (recvTransport === null || this.device === null) return;
    const { producerId } = track;
    if (this.consumers.has(producerId) || this.consuming.has(producerId)) return;

    this.consuming.add(producerId);
    void this.consume(recvTransport, track)
      .catch(() => {
        // Uma segunda chance, e só uma: o que falhou por um soluço passa; o
        // que falhou porque a track já saiu do ar não fica tentando.
        if (isRetry) return;
        setTimeout(() => {
          if (this.alive && this.recvTransport === recvTransport && this.announced.has(producerId)) {
            this.ensureConsumed(track, true);
          }
        }, CONSUME_RETRY_MS);
      })
      .finally(() => {
        this.consuming.delete(producerId);
      });
  }

  private async consume(recvTransport: Transport, announced: PresenceTrackAnnounced): Promise<void> {
    const { producerId, peerId: ownerPeerId, trackKind } = announced;
    // A sessão pode ser refeita, ou a track sair do ar, entre um `await` e
    // o seguinte: cada passo confere antes de continuar.
    const stale = (): boolean =>
      !this.alive || this.recvTransport !== recvTransport || !this.announced.has(producerId);

    const result = await this.rpcConsume(recvTransport.id, producerId);
    if (stale()) return;

    const consumer = await recvTransport.consume({
      id: result.id,
      producerId: result.producerId,
      kind: result.kind,
      rtpParameters: result.rtpParameters as never,
    });
    if (stale()) {
      consumer.close();
      return;
    }
    this.consumers.set(producerId, consumer);
    if (consumer.kind === 'audio' && consumer.rtpReceiver !== undefined) {
      attachVoiceFrameTransform(consumer.rtpReceiver, { direction: 'recv', trackKind, peerId: ownerPeerId });
    }

    consumer.on('transportclose', () => {
      this.dropConsumer(producerId, consumer);
    });
    consumer.track.addEventListener('ended', () => {
      this.dropConsumer(producerId, consumer);
    });

    try {
      await this.rpcResumeConsumer(consumer.id);
    } catch (error) {
      this.dropConsumer(producerId, consumer);
      throw error;
    }
    if (consumer.closed) return;
    consumer.resume();

    this.events.onRemoteTrack({
      consumerId: consumer.id,
      producerId: consumer.producerId,
      ownerPeerId,
      kind: consumer.kind,
      trackKind,
      track: consumer.track,
    });
  }

  /** Fecha um consumer e avisa a UI. Idempotente: os vários caminhos que chegam aqui não precisam combinar. */
  private dropConsumer(producerId: string, consumer: Consumer): void {
    if (this.consumers.get(producerId) !== consumer) return;
    this.consumers.delete(producerId);
    if (!consumer.closed) consumer.close();
    this.events.onRemoteTrackEnded(consumer.id);
  }

  // -------------------------------------------------------------------------
  // As operações de mídia, pelo canal ou pelo caminho HTTP antigo
  // -------------------------------------------------------------------------

  private rpcCreateTransport(direction: 'send' | 'recv'): Promise<MediasoupTransportInfo> {
    if (this.signal !== null) return this.signal.request('createTransport', { direction });
    return msCreateTransport(this.roomId, { peerId: this.peerId, direction });
  }

  private async rpcConnectTransport(transportId: string, dtlsParameters: unknown): Promise<void> {
    if (this.signal !== null) {
      await this.signal.request('connectTransport', { transportId, dtlsParameters });
      return;
    }
    await msConnectTransport(this.roomId, transportId, { peerId: this.peerId, dtlsParameters });
  }

  private async rpcProduce(
    transportId: string,
    kind: 'audio' | 'video',
    rtpParameters: unknown,
    trackKind: MediasoupTrackKind,
  ): Promise<string> {
    const result =
      this.signal !== null
        ? await this.signal.request('produce', { transportId, kind, rtpParameters, trackKind })
        : await msProduce(this.roomId, transportId, { peerId: this.peerId, kind, rtpParameters, trackKind });
    return result.producerId;
  }

  private rpcConsume(transportId: string, producerId: string): Promise<MediasoupConsumeResult> {
    if (this.signal !== null) return this.signal.request('consume', { transportId, producerId });
    return msConsume(this.roomId, transportId, {
      peerId: this.peerId,
      producerId,
      rtpCapabilities: this.device?.rtpCapabilities as never,
    });
  }

  private async rpcResumeConsumer(consumerId: string): Promise<void> {
    if (this.signal !== null) {
      await this.signal.request('resumeConsumer', { consumerId });
      return;
    }
    await msResumeConsumer(this.roomId, consumerId, this.peerId);
  }

  // -------------------------------------------------------------------------
  // Presença
  // -------------------------------------------------------------------------

  /**
   * Abre o canal Socket.IO de presença direto no mediasoup-sfu — a
   * substituição do heartbeat de roster de 2.5s. `disconnect` do lado do
   * servidor (fechar aba, F5, queda de rede) é o que tira alguém do roster
   * de todo mundo, em vez de depender de um TTL de 20s sem renovação.
   */
  private connectPresenceSocket(): void {
    const socket: Socket<ServerToClientPresenceEvents, ClientToServerPresenceEvents> = io(this.nodeUrl, {
      path: '/presence',
      /*
       * Função, e não um valor fixo: é chamada a CADA tentativa de conexão.
       * O token de entrada vale dois minutos; com ele fixo, qualquer
       * reconexão depois disso era recusada para sempre — o roster congelava
       * e a pessoa só voltava recarregando a página. O canal de mídia renova
       * o token a cada batimento, e é esse que vai aqui quando existe.
       */
      auth: (callback) =>
        callback({ token: this.signal?.freshToken() ?? this.token, instance: this.instanceId }),
      reconnection: true,
    });
    this.presenceSocket = socket;

    socket.on('connect', () => {
      this.presenceRetries = 0;
    });
    socket.on('connect_error', () => {
      // `active` continua `true` quando o próprio Socket.IO vai tentar de
      // novo (rede). `false` é o servidor RECUSANDO — token vencido —, e aí
      // ele não tenta mais sozinho.
      if (!this.alive || this.presenceSocket !== socket || socket.active) return;
      const delay = Math.min(30_000, 1_000 * 2 ** this.presenceRetries);
      this.presenceRetries += 1;
      setTimeout(() => {
        if (!this.alive || this.presenceSocket !== socket) return;
        // O token do canal de mídia, se houver um ainda válido; senão, um
        // novo de `apps/api`. O `auth` acima pega o que estiver valendo.
        const renewed = this.signal?.freshToken() != null;
        void (renewed ? Promise.resolve('') : this.obtainToken(true))
          .catch(() => undefined)
          .then(() => {
            if (this.alive && this.presenceSocket === socket) socket.connect();
          });
      }, delay);
    });
    socket.on('disconnect', (reason) => {
      // Derrubado PELO SERVIDOR: a moderação removeu este par. O Socket.IO
      // não reconecta nesse caso, e a conexão também não deve.
      if (reason === 'io server disconnect' && this.presenceSocket === socket) {
        this.handleFinalClose(SIGNAL_CLOSE.removed);
      }
    });

    socket.on('roster:update', (update: PresenceRosterUpdate) => {
      if (!this.alive || update.roomSlug !== this.roomId) return;
      this.presenceEntries = update.peers;
      this.rebuildRoster();
    });

    /*
     * Anúncio de tracks pelo socket de presença: é a fonte SÓ no caminho
     * HTTP. Com o canal de mídia os mesmos avisos chegam por ele, na mesma
     * fila ordenada das respostas — ouvir os dois faria um `track:closed`
     * daqui atropelar um `consume` de lá.
     */
    socket.on('track:announced', (event: PresenceTrackAnnounced) => {
      if (!this.alive || this.signal !== null) return;
      this.trackAnnounced(event);
    });
    socket.on('track:closed', (event: PresenceTrackClosed) => {
      if (!this.alive || this.signal !== null) return;
      this.trackClosed(event);
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
   * Monta o `PeerInfo[]` que a UI lê, juntando as duas fontes: QUEM está na
   * sala (socket de presença) e O QUE cada um publicou (anúncio de tracks).
   *
   * Sempre recalculado das duas, nunca remendado. As fontes chegam por
   * canais diferentes e em qualquer ordem: quando o roster era só atualizado
   * a cada evento, o anúncio de uma track que chegasse antes do roster que
   * incluía o dono dela era descartado — e o microfone daquela pessoa nunca
   * acendia na lista.
   */
  private rebuildRoster(): void {
    const tracksByPeer = new Map<string, MediasoupPublishedTrack[]>();
    for (const track of this.announced.values()) {
      const list = tracksByPeer.get(track.peerId) ?? [];
      list.push({ producerId: track.producerId, kind: track.kind, trackKind: track.trackKind });
      tracksByPeer.set(track.peerId, list);
    }
    const previous = new Map(this.roster.map((peer) => [peer.peerId, peer]));
    this.roster = this.presenceEntries.map((entry) => {
      const tracks = tracksByPeer.get(entry.peerId);
      return {
        peerId: entry.peerId,
        displayName: entry.displayName,
        isAnonymous: previous.get(entry.peerId)?.isAnonymous ?? true,
        joinedAt: entry.joinedAt,
        mediasoup: tracks === undefined ? null : { tracks },
        adminCommand: previous.get(entry.peerId)?.adminCommand ?? null,
      };
    });
    this.events.onRosterChange(this.roster);
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
      const mic = this.publications.get('mic');
      if (mic !== undefined) mic.track.enabled = !command.forceMuted;
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
}
