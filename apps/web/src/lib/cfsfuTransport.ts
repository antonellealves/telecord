/**
 * Transporte do Cloudflare Realtime SFU — o "media plane" do modo Edge global.
 *
 * Uma SESSÃO da Cloudflare é uma `RTCPeerConnection`. Este transporte mantém
 * UMA por participante: as tracks que a pessoa PUBLICA entram como `sendonly`,
 * as que ela ASSINA de outros entram como `recvonly` na mesma conexão. O SFU
 * não tem sala nem descoberta — quem publica anuncia `sessionId`/`trackName`
 * pelo roster (fora daqui), e quem assiste puxa por esse par.
 *
 * As chamadas HTTP à Cloudflare entram por `CfSfuApi` (injetável), então o
 * sequenciamento offer/answer/renegotiate é exercitável sem navegador.
 */
import type {
  CfSessionResult,
  CfSfuAnnounce,
  CfSfuPublishedTrack,
  CfSimpleResult,
  CfTracksBody,
  CfTracksResult,
  QualityMetrics,
} from '@telecord/shared';
import {
  cfCloseTracks,
  cfCreateSession,
  cfNewTracks,
  cfRenegotiate,
} from './cfsfu';
import { preferScreenCodecs } from './cfsfuQuality';

/** Porta de saída HTTP para a Cloudflare (via proxy). Injetável para testes. */
export interface CfSfuApi {
  createSession(roomSlug: string, peerId: string): Promise<CfSessionResult>;
  newTracks(
    roomSlug: string,
    peerId: string,
    sessionId: string,
    body: CfTracksBody,
  ): Promise<CfTracksResult>;
  renegotiate(
    roomSlug: string,
    peerId: string,
    sessionId: string,
    sdp: string,
  ): Promise<CfSimpleResult>;
  closeTracks(
    roomSlug: string,
    peerId: string,
    sessionId: string,
    mids: string[],
    sdp: string,
  ): Promise<CfTracksResult>;
}

/** Ligação real com o proxy `/api/cfsfu/*`. */
export const defaultCfSfuApi: CfSfuApi = {
  createSession: (roomSlug, peerId) => cfCreateSession(roomSlug, peerId),
  newTracks: (roomSlug, peerId, sessionId, body) =>
    cfNewTracks(roomSlug, peerId, sessionId, body),
  renegotiate: (roomSlug, peerId, sessionId, sdp) =>
    cfRenegotiate(roomSlug, peerId, sessionId, { sessionDescription: { type: 'answer', sdp } }),
  closeTracks: (roomSlug, peerId, sessionId, mids, sdp) =>
    cfCloseTracks(roomSlug, peerId, sessionId, {
      tracks: mids.map((mid) => ({ mid })),
      sessionDescription: { type: 'offer', sdp },
      force: false,
    }),
};

export interface CfSfuTransportOptions {
  roomSlug: string;
  peerId: string;
  iceServers: RTCIceServer[];
  /** Teto de bitrate do vídeo publicado, em bits/s. */
  videoBitrate: number;
  api?: CfSfuApi;
  /** Fábrica da conexão — trocável em teste. */
  createConnection?: (config: RTCConfiguration) => RTCPeerConnection;
}

/** Uma track remota entregue a quem assiste. */
export interface RemoteTrack {
  /** `${sessionId}:${trackName}` — estável para casar entrada e saída. */
  key: string;
  publisherSessionId: string;
  trackName: string;
  kind: 'audio' | 'video';
  stream: MediaStream;
}

type TrackHandler = (track: RemoteTrack) => void;
type StateHandler = (state: RTCPeerConnectionState) => void;

const AUDIO_MAX_BITRATE = 256_000;

/**
 * Espera o ICE terminar de reunir candidatos antes de mandar o SDP.
 *
 * A API da Cloudflare não tem endpoint de candidato (sem trickle): o offer
 * precisa sair já com os candidatos dentro. Um teto curto evita travar em rede
 * que nunca declara "complete".
 */
function waitIceGathering(pc: RTCPeerConnection, timeoutMs = 1500): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      pc.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = (): void => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

export class CfSfuTransport {
  private readonly api: CfSfuApi;
  private readonly makeConnection: (config: RTCConfiguration) => RTCPeerConnection;
  private pc: RTCPeerConnection | null = null;
  private sessionId: string | null = null;
  private readonly published = new Map<string, RTCRtpSender>();
  /** `mid` → o par remoto que aquela linha carrega, para casar no `ontrack`. */
  private readonly midToRemote = new Map<string, { sessionId: string; trackName: string }>();
  private readonly subscribed = new Set<string>();
  private readonly trackHandlers = new Set<TrackHandler>();
  private readonly stateHandlers = new Set<StateHandler>();

  constructor(private readonly options: CfSfuTransportOptions) {
    this.api = options.api ?? defaultCfSfuApi;
    this.makeConnection = options.createConnection ?? ((config) => new RTCPeerConnection(config));
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  onTrack(handler: TrackHandler): () => void {
    this.trackHandlers.add(handler);
    return () => this.trackHandlers.delete(handler);
  }

  onState(handler: StateHandler): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  /** Cria a sessão na Cloudflare e a `RTCPeerConnection` local. */
  async connect(): Promise<void> {
    if (this.pc !== null) return;
    const pc = this.makeConnection({ iceServers: this.options.iceServers, bundlePolicy: 'max-bundle' });
    pc.addEventListener('connectionstatechange', () => {
      for (const handler of this.stateHandlers) handler(pc.connectionState);
    });
    pc.addEventListener('track', (event) => this.handleTrack(event));
    this.pc = pc;

    const result = await this.api.createSession(this.options.roomSlug, this.options.peerId);
    this.sessionId = result.sessionId;
  }

  /**
   * Publica as tracks de um stream (tela + áudios) e devolve o anúncio para o
   * roster. Empurra tudo numa oferta só.
   */
  async publish(stream: MediaStream): Promise<CfSfuPublishedTrack[]> {
    const pc = this.requirePc();
    const sessionId = this.requireSession();

    const pending: { transceiver: RTCRtpTransceiver; trackName: string; kind: 'audio' | 'video' }[] = [];
    for (const track of stream.getTracks()) {
      const kind = track.kind === 'video' ? 'video' : 'audio';
      const trackName = labelFor(kind, stream);
      const transceiver = pc.addTransceiver(track, { direction: 'sendonly' });
      if (kind === 'video') {
        track.contentHint = 'detail';
        preferScreenCodecs(transceiver);
      }
      this.published.set(trackName, transceiver.sender);
      pending.push({ transceiver, trackName, kind });
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceGathering(pc);

    const localSdp = pc.localDescription?.sdp ?? offer.sdp ?? '';
    const tracks = pending.map((item) => ({
      location: 'local' as const,
      // O `mid` só existe depois de `setLocalDescription`; por isso o corpo é
      // montado agora, e não ao criar o transceiver.
      mid: item.transceiver.mid ?? '',
      trackName: item.trackName,
    }));

    const answer = await this.api.newTracks(this.options.roomSlug, this.options.peerId, sessionId, {
      sessionDescription: { type: 'offer', sdp: localSdp },
      tracks,
    });
    if (answer.sessionDescription !== undefined) {
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sessionDescription.sdp });
    }

    this.applySenderProfiles();

    return pending.map((item) => ({
      kind: item.kind,
      trackName: item.trackName,
      label: item.trackName,
    }));
  }

  /**
   * Assina as tracks anunciadas por outro par. Se o SFU exigir renegociação
   * imediata (o normal ao puxar), responde ao offer dele.
   */
  async subscribe(announce: CfSfuAnnounce): Promise<void> {
    const pc = this.requirePc();
    const sessionId = this.requireSession();
    if (announce.sessionId === sessionId) return; // não se assina a si mesmo

    const novas = announce.tracks.filter(
      (track) => !this.subscribed.has(remoteKey(announce.sessionId, track.trackName)),
    );
    if (novas.length === 0) return;

    const result = await this.api.newTracks(this.options.roomSlug, this.options.peerId, sessionId, {
      tracks: novas.map((track) => ({
        location: 'remote' as const,
        sessionId: announce.sessionId,
        trackName: track.trackName,
      })),
    });

    for (const track of result.tracks) {
      if (track.mid !== undefined && track.trackName !== undefined) {
        this.midToRemote.set(track.mid, {
          sessionId: announce.sessionId,
          trackName: track.trackName,
        });
      }
    }
    for (const track of novas) {
      this.subscribed.add(remoteKey(announce.sessionId, track.trackName));
    }

    if (result.requiresImmediateRenegotiation && result.sessionDescription !== undefined) {
      await pc.setRemoteDescription({ type: 'offer', sdp: result.sessionDescription.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const localSdp = pc.localDescription?.sdp ?? answer.sdp ?? '';
      await this.api.renegotiate(this.options.roomSlug, this.options.peerId, sessionId, localSdp);
    }
  }

  /** Coleta métricas de qualidade da conexão inteira. */
  async metrics(): Promise<QualityMetrics> {
    if (this.pc === null) return emptyMetrics();
    const stats = await this.pc.getStats();
    return readMetrics(stats);
  }

  /** Egress acumulado (bytes recebidos) — base do reporte de cota. */
  async totalBytesReceived(): Promise<number> {
    if (this.pc === null) return 0;
    const stats = await this.pc.getStats();
    let total = 0;
    stats.forEach((report) => {
      if (isInboundRtp(report) && typeof report.bytesReceived === 'number') {
        total += report.bytesReceived;
      }
    });
    return total;
  }

  /** Encerra sessão e conexão, soltando tudo. */
  close(): void {
    for (const sender of this.published.values()) {
      sender.track?.stop();
    }
    this.published.clear();
    this.midToRemote.clear();
    this.subscribed.clear();
    if (this.pc !== null) {
      this.pc.getSenders().forEach((sender) => sender.track?.stop());
      this.pc.close();
      this.pc = null;
    }
    this.sessionId = null;
  }

  private applySenderProfiles(): void {
    for (const sender of this.published.values()) {
      const kind = sender.track?.kind;
      const params = sender.getParameters() as RTCRtpSendParametersWithDegradation;
      if (params.encodings.length === 0) params.encodings = [{}];
      const encoding = params.encodings[0];
      if (encoding === undefined) continue;
      if (kind === 'video') {
        encoding.maxBitrate = this.options.videoBitrate;
        encoding.scaleResolutionDownBy = 1; // nunca reduzir a resolução
        // Preferir perder QUADRO a perder pixel — é tela, cheia de texto.
        params.degradationPreference = 'maintain-resolution';
      } else {
        encoding.maxBitrate = AUDIO_MAX_BITRATE;
      }
      void sender.setParameters(params).catch(() => undefined);
    }
  }

  private handleTrack(event: RTCTrackEvent): void {
    const mid = event.transceiver.mid;
    const remote = mid !== null ? this.midToRemote.get(mid) : undefined;
    if (remote === undefined) return; // linha sem dono conhecido: ignora
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    const remoteTrack: RemoteTrack = {
      key: remoteKey(remote.sessionId, remote.trackName),
      publisherSessionId: remote.sessionId,
      trackName: remote.trackName,
      kind: event.track.kind === 'video' ? 'video' : 'audio',
      stream,
    };
    for (const handler of this.trackHandlers) handler(remoteTrack);
  }

  private requirePc(): RTCPeerConnection {
    if (this.pc === null) throw new Error('CfSfuTransport: conecte antes de usar.');
    return this.pc;
  }

  private requireSession(): string {
    if (this.sessionId === null) throw new Error('CfSfuTransport: sessão ainda não criada.');
    return this.sessionId;
  }
}

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

/** `degradationPreference` não está no lib.dom; Chrome e Firefox o aceitam. */
interface RTCRtpSendParametersWithDegradation extends RTCRtpSendParameters {
  degradationPreference?: 'maintain-resolution' | 'maintain-framerate' | 'balanced';
}

/** Nome estável da track pela origem — o assinante puxa por ele. */
function labelFor(kind: 'audio' | 'video', stream: MediaStream): string {
  if (kind === 'video') return 'screen-video';
  // Duas tracks de áudio distintas: o som do sistema (o que é mostrado) e o
  // microfone. O rótulo permite volumes independentes do outro lado.
  return stream.getAudioTracks().length > 1 ? 'system-audio' : 'mic-audio';
}

function remoteKey(sessionId: string, trackName: string): string {
  return `${sessionId}:${trackName}`;
}

function emptyMetrics(): QualityMetrics {
  return {
    codec: null,
    width: null,
    height: null,
    framesPerSecond: null,
    bitrateKbps: null,
    packetsLost: 0,
    jitterMs: null,
    roundTripTimeMs: null,
    framesDropped: null,
    framesDecoded: null,
    availableIncomingBitrateKbps: null,
    availableOutgoingBitrateKbps: null,
  };
}

// Formas mínimas dos relatórios de `getStats` que lemos — a borda onde o mapa
// opaco vira número. Sem `any`: cada campo é checado antes de usar.
interface InboundRtpLike {
  type: 'inbound-rtp';
  kind?: string;
  bytesReceived?: number;
  packetsLost?: number;
  jitter?: number;
  framesPerSecond?: number;
  framesDropped?: number;
  framesDecoded?: number;
  frameWidth?: number;
  frameHeight?: number;
  codecId?: string;
}

function isInboundRtp(report: unknown): report is InboundRtpLike {
  return typeof report === 'object' && report !== null && (report as { type?: unknown }).type === 'inbound-rtp';
}

function readMetrics(stats: RTCStatsReport): QualityMetrics {
  const metrics = emptyMetrics();
  const codecs = new Map<string, string>();

  stats.forEach((report: unknown) => {
    if (typeof report !== 'object' || report === null) return;
    const record = report as Record<string, unknown>;
    if (record.type === 'codec' && typeof record.id === 'string' && typeof record.mimeType === 'string') {
      codecs.set(record.id, record.mimeType);
    }
  });

  stats.forEach((report: unknown) => {
    if (isInboundRtp(report) && report.kind === 'video') {
      metrics.width = numberOrNull(report.frameWidth);
      metrics.height = numberOrNull(report.frameHeight);
      metrics.framesPerSecond = numberOrNull(report.framesPerSecond);
      metrics.framesDropped = numberOrNull(report.framesDropped);
      metrics.framesDecoded = numberOrNull(report.framesDecoded);
      metrics.jitterMs = report.jitter !== undefined ? report.jitter * 1000 : null;
      metrics.packetsLost = typeof report.packetsLost === 'number' ? report.packetsLost : 0;
      if (report.codecId !== undefined) metrics.codec = codecs.get(report.codecId) ?? null;
      return;
    }
    if (typeof report === 'object' && report !== null) {
      const record = report as Record<string, unknown>;
      if (record.type === 'candidate-pair' && record.nominated === true) {
        metrics.roundTripTimeMs =
          typeof record.currentRoundTripTime === 'number' ? record.currentRoundTripTime * 1000 : null;
        metrics.availableIncomingBitrateKbps =
          typeof record.availableIncomingBitrate === 'number'
            ? record.availableIncomingBitrate / 1000
            : null;
        metrics.availableOutgoingBitrateKbps =
          typeof record.availableOutgoingBitrate === 'number'
            ? record.availableOutgoingBitrate / 1000
            : null;
      }
    }
  });

  return metrics;
}

function numberOrNull(value: number | undefined): number | null {
  return typeof value === 'number' ? value : null;
}
