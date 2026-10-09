import type { Server as HttpServer } from 'node:http';
import { pipeline } from 'node:stream';
import type * as mediasoup from 'mediasoup';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  SIGNAL_CLOSE,
  SIGNAL_MAX_FRAME_BYTES,
  SIGNAL_PATH,
  SIGNAL_PROTOCOL_VERSION,
  signPresenceToken,
  verifyPresenceToken,
  type MediasoupTrackKind,
  type MediasoupTransportInfo,
  type SignalReady,
} from '@telecord/shared';
import { peerKey, type PeerLiveness } from '../liveness';
import type { LogFields } from '../log';
import { BadRequestError, type RoomRegistry } from '../rooms';
import { RequestDispatcher, SignalRequestError, type SignalHandlers } from './dispatcher';
import { FrameDecoder, FrameEncoder } from './frames';
import { SignalSession, type SignalIdentity } from './session';
import { WebSocketDuplex } from './socketStream';

/**
 * Vida do token devolvido a cada `ping`, para a PRÓXIMA conexão.
 *
 * O token de entrada assinado por `apps/api` vale dois minutos — sobra para
 * um handshake, falta para uma reconexão vinte minutos depois. Sem um token
 * renovado aqui, qualquer queda de rede depois do segundo minuto obrigaria a
 * voltar à função serverless para pedir outro, e a retomada da voz passaria a
 * depender justamente do serviço que este canal existe para tirar do caminho.
 */
const RESUME_TOKEN_TTL_MS = 10 * 60_000;

/** Quanto tempo uma conexão tem para dizer quem é antes de ser fechada. */
const IDENTIFY_TIMEOUT_MS = 10_000;

/** Ver `OutboundQueue`: acima disto o cliente não está lendo. */
const OUTBOUND_QUEUE_LIMIT = 1_024;

export interface SignalServerOptions {
  internalSecret: string;
  registry: RoomRegistry;
  liveness: PeerLiveness;
  heartbeatIntervalMs: number;
  identifyTimeoutMs?: number;
  log: (fields: LogFields) => void;
}

export interface SignalServer {
  /** Avisa todo mundo que o processo vai reiniciar — ver `SIGNAL_CLOSE.serverShutdown`. */
  shutdown(): void;
  /** Corta o que sobrou. Sem isto o `http.Server` nunca termina de fechar: socket promovido a WebSocket não entra em `closeAllConnections`. */
  terminateAll(): void;
  readonly sessionCount: number;
}

/**
 * O canal de mídia: um WebSocket por participante, direto neste processo.
 *
 * É o equivalente do "voice gateway" do Discord. `apps/api` decide UMA vez
 * que a pessoa pode entrar e assina um token; daí em diante, tudo o que faz a
 * voz e a tela funcionarem é conversado aqui, com o mesmo processo que manda
 * no Worker — sem função serverless nem banco entre o clique e o pacote.
 *
 * ## Dois streams do Node por conexão
 *
 * ```
 * socket ─▶ FrameDecoder ─▶ RequestDispatcher        (entrada: pedidos, em ordem)
 * OutboundQueue ─▶ FrameEncoder ─▶ socket            (saída: respostas e eventos)
 * ```
 *
 * `pipeline` cuida do que costuma dar errado em código de socket: se
 * qualquer estágio quebra, todos são destruídos e a conexão cai — não sobra
 * metade de uma cadeia segurando memória. E a contrapressão atravessa os
 * dois sentidos sem código nenhum: ver `RequestDispatcher` e `OutboundQueue`.
 *
 * Mora no MESMO `http.Server` do canal de presença e das rotas internas: o
 * Caddy da VM já encaminha essa porta inteira, upgrade de WebSocket incluído,
 * então não há porta nem regra de firewall nova.
 */
export function startSignalServer(httpServer: HttpServer, options: SignalServerOptions): SignalServer {
  const { registry, liveness, internalSecret, log } = options;
  const sessions = new Set<SignalSession>();
  const sessionsByPeer = new Map<string, SignalSession>();
  const sessionsByRoom = new Map<string, Set<SignalSession>>();

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: SIGNAL_MAX_FRAME_BYTES,
    // Os quadros são JSON pequeno e a CPU deste processo é do Worker de
    // mídia, não de um compressor.
    perMessageDeflate: false,
  });

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://internal').pathname;
    } catch {
      return;
    }
    // Qualquer outro caminho é do Socket.IO (`/presence`), que tem o próprio
    // ouvinte de `upgrade` neste mesmo servidor.
    if (pathname !== SIGNAL_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => accept(ws));
  });

  function identityOf(session: SignalSession): SignalIdentity {
    // O `RequestDispatcher` só chega aqui depois do `identify`.
    if (session.identity === null) throw new SignalRequestError('unauthenticated', 'Sem identidade.');
    return session.identity;
  }

  const handlers: SignalHandlers = {
    async identify(session, data) {
      if (session.identity !== null) {
        throw new SignalRequestError('bad_request', 'Esta conexão já se identificou.');
      }
      if (data.protocol !== SIGNAL_PROTOCOL_VERSION) {
        throw new SignalRequestError('unsupported', `Protocolo ${String(data.protocol)} não é atendido por este nó.`);
      }
      const claims = typeof data.token === 'string' ? await verifyPresenceToken(data.token, internalSecret) : null;
      if (claims === null) {
        throw new SignalRequestError('unauthenticated', 'Token inválido ou vencido.');
      }
      const { peerId, roomSlug, displayName } = claims;

      const state = await registry.joinPeer(
        roomSlug,
        peerId,
        displayName,
        typeof data.sessionId === 'string' ? data.sessionId : null,
      );
      const resumeToken = await signPresenceToken({
        peerId,
        roomSlug,
        displayName,
        secret: internalSecret,
        ttlMs: RESUME_TOKEN_TTL_MS,
      });

      const key = peerKey(roomSlug, peerId);
      const channel = `signal:${session.id}`;
      // De qual página veio esta conexão — ver `PeerLiveness`.
      const instance =
        typeof data.instance === 'string' && data.instance !== '' && data.instance.length <= 64
          ? data.instance
          : null;
      if (session.closed) {
        // O cliente desistiu enquanto o Worker respondia. O par já existe no
        // registry: abre e fecha o canal para a contagem de folga começar e
        // ele não ficar para trás sem ninguém do outro lado.
        liveness.attach(roomSlug, peerId, channel, instance);
        liveness.detach(roomSlug, peerId, channel, false);
        throw new SignalRequestError('closed', 'A conexão fechou durante o identify.');
      }

      // Daqui até o `return` não há `await`: registrar a sessão e tirar o
      // retrato da sala acontecem no mesmo instante, e o que for anunciado
      // depois disso entra na fila ATRÁS desta resposta (ver `holdEvents`).
      const previous = sessionsByPeer.get(key);
      session.identity = { peerId, roomSlug, displayName };
      sessionsByPeer.set(key, session);
      let roomSessions = sessionsByRoom.get(roomSlug);
      if (roomSessions === undefined) {
        roomSessions = new Set();
        sessionsByRoom.set(roomSlug, roomSessions);
      }
      roomSessions.add(session);
      liveness.attach(roomSlug, peerId, channel, instance);

      // Mesma pessoa, outra conexão: a mais nova vence. A antiga é fechada
      // com um código que a proíbe de voltar — sem isso duas abas ficariam se
      // derrubando para sempre.
      if (previous !== undefined && previous !== session) {
        previous.close(SIGNAL_CLOSE.replaced, 'replaced');
      }

      const ready: SignalReady = {
        protocol: SIGNAL_PROTOCOL_VERSION,
        peerId,
        roomSlug,
        sessionId: state.sessionId,
        routerRtpCapabilities: registry.routerRtpCapabilities,
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        resumeToken,
        tracks: registry.publishedTracksInRoom(roomSlug).filter((track) => track.peerId !== peerId),
        transportIds: state.transportIds,
        producerIds: state.producerIds,
        consumerIds: state.consumerIds,
        speakers: registry.currentSpeakers(roomSlug),
      };
      return ready;
    },

    async ping(session) {
      const identity = identityOf(session);
      return {
        now: Date.now(),
        resumeToken: await signPresenceToken({ ...identity, secret: internalSecret, ttlMs: RESUME_TOKEN_TTL_MS }),
      };
    },

    setRtpCapabilities(session, data) {
      const { roomSlug, peerId } = identityOf(session);
      registry.setPeerRtpCapabilities(
        roomSlug,
        peerId,
        requireObject(data.rtpCapabilities, 'rtpCapabilities') as mediasoup.types.RtpCapabilities,
      );
      return {};
    },

    async createTransport(session, data) {
      const { roomSlug, peerId } = identityOf(session);
      if (data.direction !== 'send' && data.direction !== 'recv') {
        throw new BadRequestError("'direction' precisa ser 'send' ou 'recv'.");
      }
      return transportInfo(await registry.createTransport(roomSlug, peerId, data.direction));
    },

    async connectTransport(session, data) {
      const { roomSlug, peerId } = identityOf(session);
      await registry.connectTransport(
        roomSlug,
        peerId,
        requireString(data.transportId, 'transportId'),
        requireObject(data.dtlsParameters, 'dtlsParameters') as mediasoup.types.DtlsParameters,
      );
      return {};
    },

    async restartIce(session, data) {
      const { roomSlug, peerId } = identityOf(session);
      const iceParameters = await registry.restartIce(
        roomSlug,
        peerId,
        requireString(data.transportId, 'transportId'),
      );
      return { iceParameters };
    },

    async produce(session, data) {
      const { roomSlug, peerId } = identityOf(session);
      if (data.kind !== 'audio' && data.kind !== 'video') {
        throw new BadRequestError("'kind' precisa ser 'audio' ou 'video'.");
      }
      const producer = await registry.produce(
        roomSlug,
        peerId,
        requireString(data.transportId, 'transportId'),
        data.kind,
        requireObject(data.rtpParameters, 'rtpParameters') as mediasoup.types.RtpParameters,
        requireTrackKind(data.trackKind),
      );
      return { producerId: producer.id };
    },

    closeProducer(session, data) {
      const { roomSlug, peerId } = identityOf(session);
      registry.closeProducer(roomSlug, peerId, requireString(data.producerId, 'producerId'));
      return {};
    },

    async consume(session, data) {
      const { roomSlug, peerId } = identityOf(session);
      const consumer = await registry.consume(
        roomSlug,
        peerId,
        requireString(data.transportId, 'transportId'),
        requireString(data.producerId, 'producerId'),
      );
      return {
        id: consumer.id,
        producerId: consumer.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      };
    },

    async resumeConsumer(session, data) {
      const { roomSlug, peerId } = identityOf(session);
      await registry.resumeConsumer(roomSlug, peerId, requireString(data.consumerId, 'consumerId'));
      return {};
    },

    async pauseConsumer(session, data) {
      const { roomSlug, peerId } = identityOf(session);
      await registry.pauseConsumer(roomSlug, peerId, requireString(data.consumerId, 'consumerId'));
      return {};
    },
  };

  function accept(ws: WebSocket): void {
    const duplex = new WebSocketDuplex(ws);
    const session = new SignalSession(ws, duplex, OUTBOUND_QUEUE_LIMIT);
    sessions.add(session);

    ws.on('pong', () => {
      session.awaitingPong = false;
    });

    const identifyTimer = setTimeout(() => {
      if (session.identity === null) session.close(SIGNAL_CLOSE.unauthenticated, 'identify_timeout');
    }, options.identifyTimeoutMs ?? IDENTIFY_TIMEOUT_MS);
    identifyTimer.unref();

    ws.once('close', (code: number) => {
      clearTimeout(identifyTimer);
      release(session, code);
    });

    // Se um estágio quebra com a conexão ainda aberta, é defeito nosso ou
    // erro de socket: registra e corta. Depois do `close` o erro é só o
    // `pipeline` reclamando de um stream que nós mesmos encerramos.
    const onPipelineEnd = (direction: string) => (error: Error | null) => {
      if (error === null || session.closed) return;
      log({
        event: 'signal_pipeline_failed',
        direction,
        message: error.message,
        roomSlug: session.identity?.roomSlug,
        peerId: session.identity?.peerId,
      });
      session.terminate();
    };
    pipeline(duplex, new FrameDecoder(), new RequestDispatcher(session, handlers, log), onPipelineEnd('in'));
    pipeline(session.outbound, new FrameEncoder(), duplex, onPipelineEnd('out'));
  }

  function release(session: SignalSession, code: number): void {
    const serverCloseCode = session.serverCloseCode;
    session.markClosed();
    sessions.delete(session);

    const identity = session.identity;
    if (identity === null) return;
    const { roomSlug, peerId } = identity;
    const key = peerKey(roomSlug, peerId);
    if (sessionsByPeer.get(key) === session) sessionsByPeer.delete(key);
    const roomSessions = sessionsByRoom.get(roomSlug);
    roomSessions?.delete(session);
    if (roomSessions !== undefined && roomSessions.size === 0) sessionsByRoom.delete(roomSlug);

    /*
     * 1000 é o cliente saindo de propósito; 1001 é o que o navegador manda
     * ao fechar a aba ou navegar para fora. Os dois são despedida — desde que
     * tenha sido o CLIENTE a fechar. Qualquer outra coisa (1006 de rede que
     * caiu, o `clientRetry` dele mesmo, um fechamento que partiu daqui) é
     * queda, e queda ganha a folga de `PeerLiveness`.
     */
    const goodbye = serverCloseCode === null && (code === 1000 || code === 1001);
    liveness.detach(roomSlug, peerId, `signal:${session.id}`, goodbye);
  }

  function broadcast(roomSlug: string, send: (session: SignalSession, peerId: string) => void): void {
    const roomSessions = sessionsByRoom.get(roomSlug);
    if (roomSessions === undefined) return;
    for (const session of roomSessions) {
      if (session.identity !== null) send(session, session.identity.peerId);
    }
  }

  registry.on('track:announced', (event) => {
    // Quem publicou já sabe: recebeu o `producerId` na resposta do `produce`.
    broadcast(event.roomSlug, (session, peerId) => {
      if (peerId !== event.peerId) session.sendEvent('track:announced', event);
    });
  });
  registry.on('track:closed', (event) => {
    broadcast(event.roomSlug, (session, peerId) => {
      if (peerId !== event.peerId) session.sendEvent('track:closed', event);
    });
  });
  registry.on('consumer:closed', (event) => {
    sessionsByPeer
      .get(peerKey(event.roomSlug, event.peerId))
      ?.sendEvent('consumer:closed', { consumerId: event.consumerId, producerId: event.producerId });
  });
  registry.on('speakers', (event) => {
    broadcast(event.roomSlug, (session) => session.sendLatest('speakers', { speakers: event.speakers }));
  });
  registry.on('peer:removed', (event) => {
    const session = sessionsByPeer.get(peerKey(event.roomSlug, event.peerId));
    if (session === undefined) return;
    // `timeout` nunca encontra sessão aqui: a contagem só corre sem canal aberto.
    if (event.reason === 'kicked') session.close(SIGNAL_CLOSE.removed, 'removed');
    else if (event.reason === 'left') session.close(1000, 'left');
  });

  /*
   * Batimento no nível do PROTOCOLO WebSocket, partindo do servidor.
   *
   * Quem responde ao `ping` é a pilha de rede do navegador, não o JavaScript
   * da página — então uma aba em segundo plano, com os temporizadores
   * estrangulados pelo navegador, continua respondendo. Um batimento que
   * dependesse de o cliente mandar algo de tempos em tempos derrubaria
   * justamente quem deixou a sala aberta em outra aba para ouvir.
   */
  const heartbeat = setInterval(() => {
    for (const session of sessions) {
      if (session.closing) continue;
      if (session.awaitingPong) {
        log({
          event: 'signal_heartbeat_timeout',
          roomSlug: session.identity?.roomSlug,
          peerId: session.identity?.peerId,
        });
        session.terminate();
        continue;
      }
      session.ping();
    }
  }, options.heartbeatIntervalMs);
  heartbeat.unref();

  return {
    shutdown(): void {
      clearInterval(heartbeat);
      for (const session of sessions) session.close(SIGNAL_CLOSE.serverShutdown, 'server_shutdown');
    },
    terminateAll(): void {
      for (const session of sessions) session.terminate();
    },
    get sessionCount(): number {
      return sessions.size;
    },
  };
}

/** A forma que o cliente passa direto a `device.createSendTransport`/`createRecvTransport`. */
function transportInfo(transport: mediasoup.types.WebRtcTransport): MediasoupTransportInfo {
  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new BadRequestError(`campo '${field}' ausente ou inválido`);
  }
  return value;
}

function requireObject(value: unknown, field: string): object {
  if (typeof value !== 'object' || value === null) {
    throw new BadRequestError(`campo '${field}' ausente`);
  }
  return value;
}

function requireTrackKind(value: unknown): MediasoupTrackKind {
  if (value !== 'mic' && value !== 'camera' && value !== 'screen-video' && value !== 'screen-audio') {
    throw new BadRequestError("'trackKind' inválido");
  }
  return value;
}
