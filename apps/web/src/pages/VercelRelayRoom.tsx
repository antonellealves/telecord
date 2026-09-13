import { useEffect, useRef, useState } from 'react';
import type { TransportMode } from '@telecord/shared';
import { AmbientGradient } from '../components/AmbientGradient';
import { DeviceSettings } from '../components/DeviceSettings';
import { GamificationCenter } from '../components/GamificationCenter';
import { ChartIcon, LeaveIcon, MicIcon, MicOffIcon, ScreenIcon, SlidersIcon } from '../components/icons';
import { ToastStack } from '../components/ToastStack';
import { TransportPicker } from '../components/TransportPicker';
import { useRoomChrome } from '../hooks/useRoomChrome';
import { useVercelRelayRoom } from '../hooks/useVercelRelayRoom';
import { UNSUPPORTED_MESSAGE } from '../lib/vercelRelay/capabilities';
import {
  SCREEN_SHARE_QUALITIES,
  type ScreenShareQualityId,
} from '../lib/cfsfuQuality';
import { readCfSfuQuality, writeCfSfuQuality, type CfSfuQualityId } from '../lib/storage';
import styles from './P2PRoom.module.css';

interface Props {
  roomId: string;
  displayName: string;
  peerId: string;
  onLeave: () => void;
  onChangeTransport: (mode: TransportMode) => void;
}

/**
 * Sala no modo Vercel Relay: captura por WebCodecs, chunks por WebSocket, a
 * Vercel repassando. Reaproveita o desenho do modo direto (mesmo CSS).
 *
 * Papel exclusivo: quem entra é viewer (vê no canvas quem estiver compartilhando)
 * e vira streamer ao compartilhar (vê a própria tela num `<video>`).
 */
export function VercelRelayRoom({
  roomId,
  displayName,
  peerId,
  onLeave,
  onChangeTransport,
}: Props): JSX.Element {
  const room = useVercelRelayRoom({ roomId, peerId, displayName });
  const chrome = useRoomChrome({
    transport: 'vercel-relay',
    roomId,
    isMicOn: room.micOn,
    isCameraOn: false,
    isSharing: room.isSharing,
    participantCount: room.roster.length,
  });
  const [quality, setQuality] = useState<CfSfuQualityId>(readCfSfuQuality);
  const [debug, setDebug] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Preview local do streamer: o próprio stream num `<video>` (sem passar pelo relay).
  useEffect(() => {
    const el = videoRef.current;
    if (el === null) return;
    el.srcObject = room.localStream;
    return () => {
      el.srcObject = null;
    };
  }, [room.localStream]);

  if (!room.supported) {
    return (
      <>
        <AmbientGradient variant="subtle" />
        <div className={styles.shell}>
          <header className={styles.header}>
            <div className={styles.identity}>
              <span className={styles.brand}>Telecord</span>
              <h1 className={styles.title}>{roomId}</h1>
              <span className={styles.modeTag}>vercel relay</span>
            </div>
          </header>
          <p className={styles.warn}>{UNSUPPORTED_MESSAGE}</p>
          <div className={styles.controls}>
            <button type="button" className={styles.button} onClick={() => onChangeTransport('livekit')}>
              <span className={styles.text}>Usar o Servidor de mídia</span>
            </button>
          </div>
        </div>
      </>
    );
  }

  const e = room.encoderStats;
  const d = room.decoderStats;

  return (
    <>
      <AmbientGradient variant="subtle" />
      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.identity}>
            <span className={styles.brand}>Telecord</span>
            <h1 className={styles.title}>{roomId}</h1>
            <span className={styles.modeTag}>vercel relay</span>
          </div>
          <div className={styles.headerRight}>
            <span className={styles.counter}>{room.connected ? 'conectado' : 'conectando'}</span>
            <span className={styles.counter}>{room.roster.length} na sala</span>
            {room.isSharing ? <span className={styles.counter}>{room.viewers} assistindo</span> : null}
            <GamificationCenter />
          </div>
        </header>

        {room.error !== null ? <p className={styles.warn}>{room.error}</p> : null}

        <div className={styles.body}>
          <div className={styles.stage}>
            {/* Streamer: preview local em vídeo. */}
            {room.isSharing ? (
              <article className={`${styles.tile} ${styles.tileSelf}`}>
                <video ref={videoRef} className={styles.video} autoPlay playsInline muted />
                <span className={styles.tileLabel}>
                  <span className={styles.tileName}>sua tela</span>
                </span>
              </article>
            ) : null}

            {/* Viewer: o vídeo recebido é desenhado no canvas. */}
            <article
              className={styles.tile}
              style={{ display: !room.isSharing && room.receiving ? undefined : 'none' }}
            >
              <canvas ref={room.canvasRef} className={styles.video} />
              <span className={styles.tileLabel}>
                <span className={styles.tileName}>transmissão</span>
              </span>
            </article>

            {!room.isSharing && !room.receiving ? (
              <div className={styles.empty}>
                <p className={styles.emptyTitle}>Nada sendo compartilhado</p>
                <p className={styles.emptyHint}>
                  Compartilhe sua tela — ela é codificada aqui com WebCodecs e a Vercel repassa os
                  quadros aos outros. Uma pessoa compartilha por vez.
                </p>
              </div>
            ) : null}
          </div>
        </div>

        {debug ? (
          <div className={styles.warn} style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
            {e !== null
              ? `enviando · ${e.codecLabel} ${e.width}×${e.height} @${e.fps} · ${(e.bitrate / 1_000_000).toFixed(1)} Mbps · ${e.chunksSent} chunks · fila ${e.encodeQueue} · ${e.keyframes} keyframes`
              : d !== null
                ? `recebendo · ${d.width}×${d.height} · ${d.fps} fps · ${d.framesDecoded} quadros · ${d.droppedChunks} descartados · ${d.keyframes} keyframes`
                : 'sem métricas ainda'}
          </div>
        ) : null}

        <div className={styles.controls} ref={chrome.controlsRef}>
          {chrome.isSettingsOpen ? (
            <DeviceSettings
              containerRef={chrome.controlsRef}
              onClose={() => chrome.setIsSettingsOpen(false)}
              notify={chrome.push}
              themeId={chrome.themeId}
              onChangeTheme={chrome.changeTheme}
            />
          ) : null}

          <select
            className={styles.button}
            value={quality}
            onChange={(event) => {
              const id = event.target.value as CfSfuQualityId;
              setQuality(id);
              writeCfSfuQuality(id);
            }}
            disabled={room.isSharing}
            title="Resolução alvo da captura"
            aria-label="Resolução"
          >
            {SCREEN_SHARE_QUALITIES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            className={`${styles.button} ${room.isSharing ? styles.active : ''}`}
            onClick={() =>
              room.isSharing ? room.stopShare() : void room.startShare(quality as ScreenShareQualityId)
            }
          >
            <ScreenIcon />
            <span className={styles.text}>
              {room.isSharing ? 'Parar de compartilhar' : 'Compartilhar tela'}
            </span>
          </button>

          <button
            type="button"
            className={`${styles.button} ${room.micOn ? styles.active : ''}`}
            onClick={() => void room.toggleMic()}
          >
            {room.micOn ? <MicIcon /> : <MicOffIcon />}
            <span className={styles.text}>{room.micOn ? 'Microfone ligado' : 'Falar'}</span>
          </button>

          <button
            type="button"
            className={`${styles.button} ${debug ? styles.toggled : ''}`}
            onClick={() => setDebug((on) => !on)}
            aria-pressed={debug}
          >
            <ChartIcon />
            <span className={styles.text}>Debug</span>
          </button>

          <button
            type="button"
            className={`${styles.button} ${chrome.isSettingsOpen ? styles.toggled : ''}`}
            onClick={() => chrome.setIsSettingsOpen((open) => !open)}
            aria-expanded={chrome.isSettingsOpen}
            aria-haspopup="dialog"
          >
            <SlidersIcon />
            <span className={styles.text}>Configurações</span>
          </button>

          <button type="button" className={`${styles.button} ${styles.danger}`} onClick={onLeave}>
            <LeaveIcon />
            <span className={styles.text}>Sair</span>
          </button>
        </div>

        <footer className={styles.footer}>
          <p className={styles.status}>
            Experimental: a Vercel repassa os quadros em memória, sem gravar nada. Uma instância
            por vez — se travar, o Servidor de mídia aguenta sala grande.
          </p>
          <div className={styles.switcher}>
            <TransportPicker
              value="vercel-relay"
              compact
              onChange={(mode) => {
                if (mode === 'vercel-relay') return;
                onChangeTransport(mode);
              }}
            />
          </div>
        </footer>

        <ToastStack toasts={chrome.toasts} onDismiss={chrome.dismiss} />
      </div>
    </>
  );
}
