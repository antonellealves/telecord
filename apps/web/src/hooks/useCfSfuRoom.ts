import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CfSfuAnnounce, CfSfuPublishedTrack, QualityMetrics, PeerInfo } from '@telecord/shared';
import { peerHeartbeat, peerLeave } from '../lib/peers';
import { cfReportUsage } from '../lib/cfsfu';
import { CfSfuTransport } from '../lib/cfsfuTransport';
import { bitrateCeilingBps, screenShareConstraints, type BitrateCeilingId, type ScreenShareQualityId } from '../lib/cfsfuQuality';

/** Ritmo do roster: anuncia o que publiquei e descobre o que os outros publicaram. */
const TICK_MS = 2500;
/** A cada quanto tempo medir qualidade e reportar egress. */
const METRICS_MS = 3000;
const USAGE_REPORT_MS = 15_000;

export interface CfSfuRemote {
  sessionId: string;
  peerId: string;
  displayName: string;
  stream: MediaStream;
  hasVideo: boolean;
}

export interface CfSfuRoom {
  connectionState: RTCPeerConnectionState;
  isSharing: boolean;
  startScreen: (quality: ScreenShareQualityId) => Promise<void>;
  stopScreen: () => void;
  micOn: boolean;
  toggleMic: () => Promise<void>;
  remotes: CfSfuRemote[];
  localScreen: MediaStream | null;
  metrics: QualityMetrics | null;
  error: string | null;
}

interface Options {
  roomId: string;
  peerId: string;
  displayName: string;
  iceServers: RTCIceServer[];
  bitrate: BitrateCeilingId;
}

/**
 * Conduz uma sala no modo Cloudflare (Cloudflare Realtime SFU).
 *
 * Junta três peças: o `CfSfuTransport` (a conexão com o SFU), o roster do
 * telecord (heartbeat que anuncia e descobre tracks — o SFU não tem descoberta)
 * e a contabilidade de egress. A UI só lê o que sai daqui.
 */
export function useCfSfuRoom({ roomId, peerId, displayName, iceServers, bitrate }: Options): CfSfuRoom {
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState>('new');
  const [isSharing, setIsSharing] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [localScreen, setLocalScreen] = useState<MediaStream | null>(null);
  const [metrics, setMetrics] = useState<QualityMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** streams remotos por sessionId do publicador. */
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [roster, setRoster] = useState<PeerInfo[]>([]);

  const transportRef = useRef<CfSfuTransport | null>(null);
  const announceRef = useRef<CfSfuPublishedTrack[]>([]);
  const localScreenRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const bitrateRef = useRef(bitrate);
  bitrateRef.current = bitrate;

  // Sobe o transporte uma vez; a track remota entra no mapa de streams.
  useEffect(() => {
    let vivo = true;
    const transport = new CfSfuTransport({
      roomSlug: roomId,
      peerId,
      iceServers,
      videoBitrate: bitrateCeilingBps(bitrateRef.current),
    });
    transportRef.current = transport;

    transport.onState((state) => {
      if (vivo) setConnectionState(state);
    });
    transport.onTrack((remote) => {
      if (!vivo) return;
      setRemoteStreams((atual) => {
        const proximo = new Map(atual);
        const stream = proximo.get(remote.publisherSessionId) ?? new MediaStream();
        for (const track of remote.stream.getTracks()) {
          if (!stream.getTracks().includes(track)) stream.addTrack(track);
        }
        proximo.set(remote.publisherSessionId, stream);
        return proximo;
      });
    });

    transport.connect().catch(() => {
      if (vivo) setError('Não foi possível criar a sessão no Cloudflare Realtime.');
    });

    return () => {
      vivo = false;
      transport.close();
      transportRef.current = null;
      for (const track of localScreenRef.current?.getTracks() ?? []) track.stop();
      for (const track of micStreamRef.current?.getTracks() ?? []) track.stop();
      void peerLeave(roomId, peerId).catch(() => undefined);
    };
  }, [roomId, peerId, iceServers]);

  // O batimento: anuncia o que publiquei e assina o que os outros publicaram.
  useEffect(() => {
    let vivo = true;
    let timer = 0;

    const bater = async (): Promise<void> => {
      const transport = transportRef.current;
      try {
        const announce: CfSfuAnnounce | null =
          transport?.currentSessionId != null && announceRef.current.length > 0
            ? { sessionId: transport.currentSessionId, tracks: announceRef.current }
            : null;
        const { peers } = await peerHeartbeat(roomId, peerId, displayName, announce);
        if (!vivo) return;
        setRoster(peers);

        if (transport !== null) {
          for (const peer of peers) {
            if (peer.peerId === peerId || peer.cfsfu == null) continue;
            await transport.subscribe(peer.cfsfu).catch(() => undefined);
          }
        }
      } catch {
        // Uma falha de roster não derruba a sessão de mídia já estabelecida.
      } finally {
        if (vivo) timer = window.setTimeout(() => void bater(), TICK_MS);
      }
    };
    void bater();

    return () => {
      vivo = false;
      window.clearTimeout(timer);
    };
  }, [roomId, peerId, displayName]);

  // Métricas para o diagnóstico e reporte de egress para a cota.
  useEffect(() => {
    let vivo = true;
    let ultimoEgress = 0;
    let desdeReporte = 0;

    const metricsTimer = window.setInterval(() => {
      const transport = transportRef.current;
      if (transport === null) return;
      void transport.metrics().then((m) => {
        if (vivo) setMetrics(m);
      });
    }, METRICS_MS);

    const usageTimer = window.setInterval(() => {
      const transport = transportRef.current;
      if (transport === null) return;
      void transport.totalBytesReceived().then((total) => {
        const delta = total - ultimoEgress;
        ultimoEgress = total;
        desdeReporte += delta;
        if (desdeReporte > 0) {
          void cfReportUsage(roomId, peerId, desdeReporte).catch(() => undefined);
          desdeReporte = 0;
        }
      });
    }, USAGE_REPORT_MS);

    return () => {
      vivo = false;
      window.clearInterval(metricsTimer);
      window.clearInterval(usageTimer);
    };
  }, [roomId, peerId]);

  const startScreen = useCallback(async (quality: ScreenShareQualityId) => {
    const transport = transportRef.current;
    if (transport === null) return;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia(screenShareConstraints(quality));
      const video = stream.getVideoTracks()[0];
      video?.addEventListener('ended', () => stopScreenInternal());
      localScreenRef.current = stream;
      setLocalScreen(stream);
      const published = await transport.publish(stream);
      announceRef.current = [...announceRef.current, ...published];
      setIsSharing(true);
    } catch {
      // Cancelar o seletor do navegador não é erro.
    }
  }, []);

  const stopScreenInternal = useCallback(() => {
    for (const track of localScreenRef.current?.getTracks() ?? []) track.stop();
    localScreenRef.current = null;
    setLocalScreen(null);
    setIsSharing(false);
    // A track parada deixa de mandar pacotes; o SFU a coleta em ~30 s. O
    // anúncio de vídeo sai do roster para os outros pararem de puxar.
    announceRef.current = announceRef.current.filter((track) => track.kind !== 'video');
  }, []);

  const stopScreen = useCallback(() => stopScreenInternal(), [stopScreenInternal]);

  const toggleMic = useCallback(async () => {
    const transport = transportRef.current;
    if (transport === null) return;
    if (micOn) {
      for (const track of micStreamRef.current?.getTracks() ?? []) track.stop();
      micStreamRef.current = null;
      setMicOn(false);
      announceRef.current = announceRef.current.filter((track) => track.label !== 'mic-audio');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48_000 },
      });
      micStreamRef.current = stream;
      const published = await transport.publish(stream);
      announceRef.current = [...announceRef.current, ...published];
      setMicOn(true);
    } catch {
      setError('Não foi possível abrir o microfone.');
    }
  }, [micOn]);

  const remotes = useMemo<CfSfuRemote[]>(() => {
    const bySession = new Map<string, PeerInfo>();
    for (const peer of roster) {
      if (peer.cfsfu != null) bySession.set(peer.cfsfu.sessionId, peer);
    }
    const out: CfSfuRemote[] = [];
    for (const [sessionId, stream] of remoteStreams) {
      const peer = bySession.get(sessionId) ?? null;
      out.push({
        sessionId,
        peerId: peer?.peerId ?? sessionId,
        displayName: peer?.displayName ?? 'alguém',
        stream,
        hasVideo: stream.getVideoTracks().some((track) => track.readyState === 'live'),
      });
    }
    return out;
  }, [remoteStreams, roster]);

  return {
    connectionState,
    isSharing,
    startScreen,
    stopScreen,
    micOn,
    toggleMic,
    remotes,
    localScreen,
    metrics,
    error,
  };
}
