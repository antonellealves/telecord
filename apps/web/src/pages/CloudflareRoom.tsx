import { useEffect, useRef, useState } from 'react';
import { AmbientGradient } from '../components/AmbientGradient';
import { LeaveIcon, MicIcon, MicOffIcon, ScreenIcon } from '../components/icons';
import { TransportPicker } from '../components/TransportPicker';
import { useCfSfuRoom, type CfSfuRemote } from '../hooks/useCfSfuRoom';
import { fetchCfSfuConfig } from '../lib/cfsfu';
import { DEFAULT_ICE_SERVERS } from '../lib/ice';
import {
  SCREEN_SHARE_QUALITIES,
  type ScreenShareQualityId,
} from '../lib/cfsfuQuality';
import {
  readCfSfuBitrate,
  readCfSfuQuality,
  writeCfSfuQuality,
  type CfSfuQualityId,
} from '../lib/storage';
import type { TransportMode } from '@telecord/shared';
import styles from './P2PRoom.module.css';

interface Props {
  roomId: string;
  displayName: string;
  peerId: string;
  onLeave: () => void;
  onChangeTransport: (mode: TransportMode) => void;
}

/**
 * Sala no modo Cloudflare (Cloudflare Realtime SFU).
 *
 * Terceiro paradigma, ao lado do LiveKit e do P2P — e sem tocar em nenhum dos
 * dois. Foco em compartilhamento de tela de qualidade máxima: o SFU é
 * passthrough, então a nitidez é a que o navegador de quem compartilha
 * codificar. Reaproveita o desenho do modo direto (mesmo CSS), porque a
 * estrutura — quadros num palco, barra de controles — é a mesma.
 */
export function CloudflareRoom({
  roomId,
  displayName,
  peerId,
  onLeave,
  onChangeTransport,
}: Props): JSX.Element {
  const [iceServers, setIceServers] = useState<RTCIceServer[]>(DEFAULT_ICE_SERVERS);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [quality, setQuality] = useState<CfSfuQualityId>(readCfSfuQuality);

  useEffect(() => {
    let vivo = true;
    void fetchCfSfuConfig()
      .then((config) => {
        if (!vivo) return;
        setEnabled(config.enabled);
        if (config.iceServers.length > 0) {
          setIceServers(config.iceServers.map((server) => ({ urls: server.urls })));
        }
      })
      .catch(() => {
        if (vivo) setEnabled(false);
      });
    return () => {
      vivo = false;
    };
  }, []);

  const room = useCfSfuRoom({
    roomId,
    peerId,
    displayName,
    iceServers,
    bitrate: readCfSfuBitrate(),
  });

  const changeQuality = (id: CfSfuQualityId): void => {
    setQuality(id);
    writeCfSfuQuality(id);
  };

  if (enabled === false) {
    return (
      <>
        <AmbientGradient variant="subtle" />
        <div className={styles.shell}>
          <header className={styles.header}>
            <div className={styles.identity}>
              <span className={styles.brand}>Telecord</span>
              <h1 className={styles.title}>{roomId}</h1>
              <span className={styles.modeTag}>cloudflare</span>
            </div>
          </header>
          <p className={styles.warn}>
            O Cloudflare Realtime não está configurado neste servidor. Volte e escolha o Servidor de mídia
            ou a Conexão direta.
          </p>
          <div className={styles.controls}>
            <button
              type="button"
              className={`${styles.button}`}
              onClick={() => onChangeTransport('livekit')}
            >
              <span className={styles.text}>Usar o Servidor de mídia</span>
            </button>
          </div>
        </div>
      </>
    );
  }

  const m = room.metrics;

  return (
    <>
      <AmbientGradient variant="subtle" />
      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.identity}>
            <span className={styles.brand}>Telecord</span>
            <h1 className={styles.title}>{roomId}</h1>
            <span className={styles.modeTag}>cloudflare</span>
          </div>
          <div className={styles.headerRight}>
            <span className={styles.counter}>
              {room.connectionState === 'connected' ? 'conectado' : room.connectionState}
            </span>
            {m !== null && m.width !== null ? (
              <span className={styles.counter}>
                {m.width}×{m.height}
                {m.framesPerSecond !== null ? ` · ${Math.round(m.framesPerSecond)}fps` : ''}
                {m.codec !== null ? ` · ${m.codec.replace('video/', '')}` : ''}
              </span>
            ) : null}
          </div>
        </header>

        {room.error !== null ? <p className={styles.warn}>{room.error}</p> : null}

        <div className={styles.body}>
          <div className={styles.stage}>
            {room.localScreen !== null ? (
              <Tile stream={room.localScreen} name="sua tela" muted self />
            ) : null}
            {room.remotes.map((remote) => (
              <RemoteTile key={remote.sessionId} remote={remote} />
            ))}
            {room.localScreen === null && room.remotes.length === 0 ? (
              <div className={styles.empty}>
                <p className={styles.emptyTitle}>Nada sendo compartilhado</p>
                <p className={styles.emptyHint}>
                  Compartilhe sua tela — ela sobe para o edge da Cloudflare e chega aos outros na
                  resolução que seu navegador codificar.
                </p>
              </div>
            ) : null}
          </div>
        </div>

        <div className={styles.controls}>
          <select
            className={styles.button}
            value={quality}
            onChange={(event) => changeQuality(event.target.value as ScreenShareQualityId)}
            disabled={room.isSharing}
            title="Resolução alvo da captura de tela"
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
            onClick={() => (room.isSharing ? room.stopScreen() : void room.startScreen(quality))}
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

          <button type="button" className={`${styles.button} ${styles.danger}`} onClick={onLeave}>
            <LeaveIcon />
            <span className={styles.text}>Sair</span>
          </button>
        </div>

        <footer className={styles.footer}>
          <p className={styles.status}>
            A tela sobe uma vez para o edge da Cloudflare, que a repassa a cada pessoa — sem
            recodificar. Qualidade máxima, e o consumo é de quem assiste.
          </p>
          <div className={styles.switcher}>
            <TransportPicker
              value="cfsfu"
              compact
              onChange={(mode) => {
                if (mode === 'cfsfu') return;
                onChangeTransport(mode);
              }}
            />
          </div>
        </footer>
      </div>
    </>
  );
}

function RemoteTile({ remote }: { remote: CfSfuRemote }): JSX.Element {
  return <Tile stream={remote.stream} name={remote.displayName} muted={false} self={false} />;
}

function Tile({
  stream,
  name,
  muted,
  self,
}: {
  stream: MediaStream;
  name: string;
  muted: boolean;
  self: boolean;
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (el === null) return;
    el.srcObject = stream;
    return () => {
      el.srcObject = null;
    };
  }, [stream]);

  const hasVideo = stream.getVideoTracks().some((track) => track.readyState === 'live');

  return (
    <article className={`${styles.tile} ${self ? styles.tileSelf : ''}`}>
      <video ref={videoRef} className={styles.video} autoPlay playsInline muted={muted} />
      {!hasVideo ? (
        <div className={styles.tilePlaceholder}>
          <span className={styles.initials}>{name.slice(0, 2).toUpperCase()}</span>
        </div>
      ) : null}
      <span className={styles.tileLabel}>
        <span className={styles.tileName}>{name}</span>
      </span>
    </article>
  );
}
