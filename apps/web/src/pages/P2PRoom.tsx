import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { P2P_MAX_PEERS } from '@telecord/shared';
import { AmbientGradient } from '../components/AmbientGradient';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { TransportPicker } from '../components/TransportPicker';
import { useP2PMesh, type RemotePeer } from '../hooks/useP2PMesh';
import { useToasts } from '../hooks/useToasts';
import { ToastStack } from '../components/ToastStack';
import { CameraIcon, CameraOffIcon, LeaveIcon, MicIcon, MicOffIcon, ScreenIcon } from '../components/icons';
import { screenShareCaptureOptions } from '../lib/media';
import { writeTransport } from '../lib/storage';
import styles from './P2PRoom.module.css';

interface Props {
  roomId: string;
  displayName: string;
  peerId: string;
  onLeave: () => void;
}

const ESTADO_TEXTO: Record<RemotePeer['state'], string> = {
  novo: 'conectando…',
  ligando: 'negociando…',
  ligado: 'conectado',
  falhou: 'não conectou',
};

/** Um quadro remoto. O `<video>` recebe o stream por ref, não por atributo. */
function PeerTile({ peer }: { peer: RemotePeer }): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (el === null) return;
    // `srcObject` não existe como atributo JSX: precisa ser atribuído.
    el.srcObject = peer.stream;
    return () => {
      el.srcObject = null;
    };
  }, [peer.stream]);

  const temVideo = peer.stream?.getVideoTracks().some((t) => t.enabled) ?? false;

  return (
    <article className={styles.tile}>
      <video ref={videoRef} className={styles.video} autoPlay playsInline />
      {!temVideo ? (
        <div className={styles.tilePlaceholder}>
          <span className={styles.initials}>
            {peer.displayName.slice(0, 2).toUpperCase()}
          </span>
        </div>
      ) : null}
      <span className={styles.tileLabel}>
        {peer.displayName}
        <span
          className={`${styles.tileState} ${peer.state === 'falhou' ? styles.tileStateBad : ''}`}
        >
          {ESTADO_TEXTO[peer.state]}
        </span>
      </span>
    </article>
  );
}

/**
 * Sala no modo de conexão direta.
 *
 * ## Por que é uma tela separada, e não a mesma da sala normal
 *
 * A `RoomShell` inteira é construída sobre o contexto do LiveKit: chat e
 * soundboard viajam pelo canal de dados do SFU, o volume por participante lê
 * as tracks dele, a lista de pessoas vem dos eventos dele. Nada disso existe
 * aqui. Enfiar os dois modos na mesma tela significaria metade dos recursos
 * desligados sem explicação — esta tela mostra o que ELA tem, e diz o que não
 * tem.
 *
 * O que existe aqui: voz, câmera e tela, direto entre navegadores. O que não
 * existe: chat, sons, gravação de sessão e sala com muita gente.
 */
export function P2PRoom({ roomId, displayName, peerId, onLeave }: Props): JSX.Element {
  const navigate = useNavigate();
  const { toasts, push, dismiss } = useToasts();

  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);

  const mesh = useP2PMesh({ roomSlug: roomId, peerId, displayName, localStream, enabled: true });

  useEffect(() => {
    const el = localVideoRef.current;
    if (el === null) return;
    el.srcObject = localStream;
  }, [localStream]);

  /*
   * Um `MediaStream` só para tudo que este navegador publica.
   *
   * Trocar faixa dentro de um stream estável é mais barato que criar stream
   * novo: o hook da malha só precisa reenviar as faixas, e não refazer a
   * conexão inteira.
   */
  const trocarFaixas = useCallback(
    (novas: MediaStreamTrack[], tipo: 'audio' | 'video') => {
      setLocalStream((atual) => {
        const proximo = new MediaStream(atual?.getTracks() ?? []);
        for (const track of proximo.getTracks()) {
          if (track.kind === tipo) {
            track.stop();
            proximo.removeTrack(track);
          }
        }
        for (const track of novas) proximo.addTrack(track);
        return proximo.getTracks().length === 0 ? null : proximo;
      });
    },
    [],
  );

  const alternarMic = useCallback(async () => {
    if (micOn) {
      trocarFaixas([], 'audio');
      setMicOn(false);
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      trocarFaixas(s.getAudioTracks(), 'audio');
      setMicOn(true);
    } catch {
      push('error', 'Não deu para abrir o microfone.');
    }
  }, [micOn, trocarFaixas, push]);

  const alternarCam = useCallback(async () => {
    if (camOn) {
      trocarFaixas([], 'video');
      setCamOn(false);
      setScreenOn(false);
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
      trocarFaixas(s.getVideoTracks(), 'video');
      setCamOn(true);
      setScreenOn(false);
    } catch {
      push('error', 'Não deu para abrir a câmera.');
    }
  }, [camOn, trocarFaixas, push]);

  const alternarTela = useCallback(async () => {
    if (screenOn) {
      trocarFaixas([], 'video');
      setScreenOn(false);
      return;
    }
    try {
      const s = await navigator.mediaDevices.getDisplayMedia(
        screenShareCaptureOptions() as DisplayMediaStreamOptions,
      );
      const video = s.getVideoTracks();
      // Parar pelo botão do navegador tem que refletir na interface.
      video[0]?.addEventListener('ended', () => {
        trocarFaixas([], 'video');
        setScreenOn(false);
      });
      trocarFaixas(video, 'video');
      setScreenOn(true);
      setCamOn(false);
    } catch {
      // Cancelar o seletor do navegador não é erro.
    }
  }, [screenOn, trocarFaixas]);

  const sair = useCallback(() => {
    for (const track of localStream?.getTracks() ?? []) track.stop();
    onLeave();
  }, [localStream, onLeave]);

  const conectados = useMemo(
    () => mesh.peers.filter((p) => p.state === 'ligado').length,
    [mesh.peers],
  );

  return (
    <>
      <AmbientGradient variant="subtle" />

      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.identity}>
            <span className={styles.brand}>Telecord</span>
            <h1 className={styles.title}>{roomId}</h1>
            <span className={styles.modeTag}>conexão direta</span>
          </div>
          <ConnectionBanner status={mesh.error === null ? 'connected' : 'reconnecting'} />
        </header>

        {/*
          * Sinalização quebrada é fatal neste modo, e precisa ser dita por
          * extenso: sem ela ninguém se acha, a sala fica vazia para sempre e a
          * tela pareceria apenas "sala sem ninguém". O banner pequeno do topo
          * não basta para uma falha que impede tudo.
          */}
        {mesh.error !== null ? <p className={styles.warn}>{mesh.error}</p> : null}

        {mesh.isFull ? (
          <p className={styles.warn}>
            A sala chegou ao teto de {P2P_MAX_PEERS} pessoas do modo direto. Quem entrar agora
            não vai conseguir conectar — para uma sala maior, use o servidor de mídia.
          </p>
        ) : null}

        <div className={styles.stage}>
          <article className={`${styles.tile} ${styles.tileSelf}`}>
            <video ref={localVideoRef} className={styles.video} autoPlay playsInline muted />
            {!camOn && !screenOn ? (
              <div className={styles.tilePlaceholder}>
                <span className={styles.initials}>{displayName.slice(0, 2).toUpperCase()}</span>
              </div>
            ) : null}
            <span className={styles.tileLabel}>você</span>
          </article>

          {mesh.peers.map((peer) => (
            <PeerTile key={peer.peerId} peer={peer} />
          ))}

          {mesh.peers.length === 0 ? (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>Ninguém mais por aqui</p>
              <p className={styles.emptyHint}>
                Mande o endereço desta sala para alguém. No modo direto, cada pessoa conecta
                com cada outra — sem servidor no meio da mídia.
              </p>
            </div>
          ) : null}
        </div>

        <div className={styles.controls}>
          <button
            type="button"
            className={`${styles.button} ${micOn ? styles.active : ''}`}
            onClick={() => void alternarMic()}
          >
            {micOn ? <MicIcon /> : <MicOffIcon />}
            <span className={styles.text}>{micOn ? 'Microfone ligado' : 'Falar'}</span>
          </button>

          <button
            type="button"
            className={`${styles.button} ${camOn ? styles.active : ''}`}
            onClick={() => void alternarCam()}
          >
            {camOn ? <CameraIcon /> : <CameraOffIcon />}
            <span className={styles.text}>{camOn ? 'Câmera ligada' : 'Câmera'}</span>
          </button>

          <button
            type="button"
            className={`${styles.button} ${screenOn ? styles.active : ''}`}
            onClick={() => void alternarTela()}
          >
            <ScreenIcon />
            <span className={styles.text}>
              {screenOn ? 'Parar de compartilhar' : 'Compartilhar tela'}
            </span>
          </button>

          <button type="button" className={`${styles.button} ${styles.danger}`} onClick={sair}>
            <LeaveIcon />
            <span className={styles.text}>Sair</span>
          </button>
        </div>

        <footer className={styles.footer}>
          <p className={styles.status}>
            {conectados} de {mesh.peers.length} {mesh.peers.length === 1 ? 'par' : 'pares'}{' '}
            conectado{conectados === 1 ? '' : 's'} direto.
            {mesh.peers.some((p) => p.state === 'falhou')
              ? ' Quem não conectou está numa rede que bloqueia o caminho direto.'
              : ''}
          </p>

          {/*
            * Trocar de modo aqui SAI da sala e volta: são duas pilhas
            * diferentes, e trocar por baixo deixaria metade da tela falando
            * com o SFU e metade com a malha.
            */}
          <div className={styles.switcher}>
            <TransportPicker
              value="p2p"
              compact
              onChange={(mode) => {
                if (mode === 'p2p') return;
                writeTransport(mode);
                for (const track of localStream?.getTracks() ?? []) track.stop();
                navigate(0);
              }}
            />
            <span className={styles.switcherHint}>
              Trocar recarrega a sala — chat e sons só existem no servidor de mídia.
            </span>
          </div>
        </footer>
      </div>

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
