import { useCallback, useEffect, useRef, useState } from 'react';
import type { PeerInfo } from '@telecord/shared';
import { classifyCongestion, nextBitrate } from '@telecord/shared';
import { peerHeartbeat, peerLeave } from '../lib/peers';
import {
  detectRelayCapabilities,
  isRelaySupported,
} from '../lib/vercelRelay/capabilities';
import { screenShareConstraints, screenShareQuality, type ScreenShareQualityId } from '../lib/cfsfuQuality';
import { ScreenDecoder, type DecoderStats } from '../lib/vercelRelay/decoder';
import { ScreenEncoder, type EncoderStats } from '../lib/vercelRelay/encoder';
import { VercelWebSocketTransport } from '../lib/vercelRelay/transport';

const TICK_MS = 2500;
const METRICS_MS = 1000;

/** Faixa de bitrate por altura de quadro (SPEC §4). */
function bitrateBand(height: number): { min: number; max: number; initial: number } {
  if (height >= 2000) return { min: 10_000_000, max: 30_000_000, initial: 12_000_000 };
  if (height >= 1300) return { min: 5_000_000, max: 16_000_000, initial: 6_000_000 };
  if (height >= 1000) return { min: 2_000_000, max: 12_000_000, initial: 4_000_000 };
  return { min: 1_000_000, max: 8_000_000, initial: 2_500_000 };
}

export type RelayRole = 'viewer' | 'streamer';

export interface VercelRelayRoom {
  supported: boolean;
  role: RelayRole;
  connected: boolean;
  isSharing: boolean;
  /** Alguém está transmitindo e este cliente está recebendo vídeo. */
  receiving: boolean;
  viewers: number;
  roster: PeerInfo[];
  error: string | null;
  encoderStats: EncoderStats | null;
  decoderStats: DecoderStats | null;
  /** Onde o viewer desenha o vídeo recebido. */
  canvasRef: React.RefObject<HTMLCanvasElement>;
  /** A captura local, para o streamer se ver num `<video>` sem passar pelo relay. */
  localStream: MediaStream | null;
  startShare: (quality: ScreenShareQualityId) => Promise<void>;
  stopShare: () => void;
}

interface Options {
  roomId: string;
  peerId: string;
  displayName: string;
}

/**
 * Conduz uma sala no modo Vercel Relay.
 *
 * Papel exclusivo: ao entrar, este cliente é VIEWER (recebe o que estiver sendo
 * compartilhado). Ao clicar em compartilhar, vira STREAMER (a função de relay
 * aceita um só por sala); ao parar, volta a viewer. A presença (nomes) vem do
 * mesmo heartbeat do P2P; a mídia, do WebSocket.
 */
export function useVercelRelayRoom({ roomId, peerId, displayName }: Options): VercelRelayRoom {
  const [supported] = useState(() => isRelaySupported(detectRelayCapabilities()));
  const [role, setRole] = useState<RelayRole>('viewer');
  const [connected, setConnected] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [viewers, setViewers] = useState(0);
  const [roster, setRoster] = useState<PeerInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [encoderStats, setEncoderStats] = useState<EncoderStats | null>(null);
  const [decoderStats, setDecoderStats] = useState<DecoderStats | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const transportRef = useRef<VercelWebSocketTransport | null>(null);
  const encoderRef = useRef<ScreenEncoder | null>(null);
  const decoderRef = useRef<ScreenDecoder | null>(null);
  const shareStreamRef = useRef<MediaStream | null>(null);
  const bandRef = useRef({ min: 2_000_000, max: 12_000_000, initial: 4_000_000 });
  const bitrateRef = useRef(4_000_000);

  // Presença: mesmo heartbeat dos outros modos, só para nomes e contagem.
  useEffect(() => {
    if (!supported) return;
    let vivo = true;
    let timer = 0;
    const bater = async (): Promise<void> => {
      try {
        const { peers } = await peerHeartbeat(roomId, peerId, displayName);
        if (vivo) setRoster(peers);
      } catch {
        // Falha de presença não derruba a mídia.
      } finally {
        if (vivo) timer = window.setTimeout(() => void bater(), TICK_MS);
      }
    };
    void bater();
    return () => {
      vivo = false;
      window.clearTimeout(timer);
      void peerLeave(roomId, peerId).catch(() => undefined);
    };
  }, [roomId, peerId, displayName, supported]);

  /** Liga um transporte no papel dado e assina os eventos de mídia. */
  const openTransport = useCallback(
    (nextRole: RelayRole): VercelWebSocketTransport => {
      transportRef.current?.disconnect();
      const transport = new VercelWebSocketTransport({ roomId, peerId, role: nextRole });
      transportRef.current = transport;

      transport.onOpen((open) => setConnected(open));

      transport.onControl((message) => {
        if (message.t === 'init') {
          // Sou viewer: (re)configura o decoder para o stream anunciado.
          const canvas = canvasRef.current;
          if (canvas === null) return;
          if (decoderRef.current === null) {
            decoderRef.current = new ScreenDecoder(canvas, () => transport.requestKeyframe());
          }
          decoderRef.current.configure(message.codec, message.width, message.height);
          setReceiving(true);
        } else if (message.t === 'end') {
          decoderRef.current?.close();
          setReceiving(false);
        } else if (message.t === 'viewers') {
          setViewers(message.count);
        } else if (message.t === 'keyframe-request') {
          encoderRef.current?.requestKeyframe();
        } else if (message.t === 'congestion') {
          // Adaptive bitrate: o relay disse como está a rede.
          const state = classifyCongestion(message.maxBufferedBytes, message.dropped);
          const band = bandRef.current;
          const next = nextBitrate(bitrateRef.current, state, band.min, band.max);
          if (next !== bitrateRef.current) {
            bitrateRef.current = next;
            encoderRef.current?.updateBitrate(next);
          }
        }
      });

      transport.onChunk((frame) => decoderRef.current?.push(frame));
      transport.connect();
      return transport;
    },
    [roomId, peerId],
  );

  // Ao montar (e suportado), entra como viewer.
  useEffect(() => {
    if (!supported) return;
    openTransport('viewer');
    return () => {
      encoderRef.current?.stop();
      encoderRef.current = null;
      decoderRef.current?.close();
      decoderRef.current = null;
      for (const track of shareStreamRef.current?.getTracks() ?? []) track.stop();
      shareStreamRef.current = null;
      transportRef.current?.disconnect();
      transportRef.current = null;
    };
  }, [supported, openTransport]);

  // Métricas ao vivo.
  useEffect(() => {
    if (!supported) return;
    const id = window.setInterval(() => {
      setEncoderStats(encoderRef.current?.getStats() ?? null);
      setDecoderStats(decoderRef.current?.getStats() ?? null);
    }, METRICS_MS);
    return () => window.clearInterval(id);
  }, [supported]);

  const startShare = useCallback(
    async (quality: ScreenShareQualityId) => {
      setError(null);
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia(screenShareConstraints(quality));
        shareStreamRef.current = stream;
        setLocalStream(stream);
        const track = stream.getVideoTracks()[0];
        const settings = track?.getSettings() ?? {};
        const option = screenShareQuality(quality);
        const width = settings.width ?? option.width;
        const height = settings.height ?? option.height;
        const fps = Math.round(settings.frameRate ?? option.fps);
        const band = bitrateBand(height);
        bandRef.current = band;
        bitrateRef.current = band.initial;

        // Vira streamer: troca o transporte de papel.
        const transport = openTransport('streamer');
        setRole('streamer');

        const encoder = new ScreenEncoder();
        encoderRef.current = encoder;
        await encoder.start(
          stream,
          { width, height, fps, bitrate: band.initial },
          transport,
          (message) => setError(message),
        );
        setIsSharing(true);
      } catch (caught) {
        // Cancelar o seletor do navegador não é erro.
        if (caught instanceof Error && caught.name !== 'NotAllowedError') {
          setError(caught.message);
        }
        stopShareInternal();
      }
    },
    [openTransport],
  );

  const stopShareInternal = useCallback(() => {
    encoderRef.current?.stop();
    encoderRef.current = null;
    for (const track of shareStreamRef.current?.getTracks() ?? []) track.stop();
    shareStreamRef.current = null;
    setLocalStream(null);
    setIsSharing(false);
    setViewers(0);
    // Volta a ser viewer para ver se alguém mais compartilha.
    setRole('viewer');
    openTransport('viewer');
  }, [openTransport]);

  const stopShare = useCallback(() => stopShareInternal(), [stopShareInternal]);

  return {
    supported,
    role,
    connected,
    isSharing,
    receiving,
    viewers,
    roster,
    error,
    encoderStats,
    decoderStats,
    canvasRef,
    localStream,
    startShare,
    stopShare,
  };
}
