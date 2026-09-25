import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import type { TransportMode } from '@telecord/shared';
import { AmbientGradient } from '../../components/AmbientGradient';
import { CameraStrip } from '../../components/CameraStrip';
import { ChannelNav } from '../../components/ChannelNav';
import { ChatPanel } from '../../components/ChatPanel';
import { ConnectionBanner } from '../../components/ConnectionBanner';
import { ControlBar } from '../../components/ControlBar';
import { DeviceSettings } from '../../components/DeviceSettings';
import { GamificationCenter } from '../../components/GamificationCenter';
import { ParticipantSidebar } from '../../components/ParticipantSidebar';
import { RoomPanel } from '../../components/RoomPanel';
import { ScreenStage } from '../../components/ScreenStage';
import { Soundboard } from '../../components/Soundboard';
import { ToastStack } from '../../components/ToastStack';
import { TransportPicker } from '../../components/TransportPicker';
import { useChannelNav } from '../../hooks/useChannelNav';
import { useResizablePanel } from '../../hooks/useResizablePanel';
import { useRoomSounds } from '../../hooks/useRoomSounds';
import { useSoundboardSpeakers } from '../../hooks/useSoundboardSpeakers';
import { useAuth } from '../../hooks/useAuth';
import { useOverlay } from '../../hooks/useOverlay';
import { ParticipantOverlay } from '../../components/ParticipantOverlay';
import { useSoundVolume } from '../../hooks/useSoundVolume';
import { useToasts } from '../../hooks/useToasts';
import { trackEvent, trackSoundPlayed } from '../../lib/gamification';
import type { ScreenQualityId } from '../../lib/media';
import {
  applyTheme,
  readParticipantsOpen,
  readScreenQuality,
  readTheme,
  writeParticipantsOpen,
  writeScreenQuality,
  writeTheme,
  type ThemeId,
} from '../../lib/storage';
import { MediasoupAudioPlaybackGate } from './MediasoupAudioPlaybackGate';
import { useMediasoupAway } from '../../hooks/mediasoup/useMediasoupAway';
import { useMediasoupCameras } from '../../hooks/mediasoup/useMediasoupCameras';
import { useMediasoupChat } from '../../hooks/mediasoup/useMediasoupChat';
import { useMediasoupConnectionStatus } from '../../hooks/mediasoup/useMediasoupConnectionStatus';
import { useMediasoupEngine } from '../../hooks/mediasoup/useMediasoupEngine';
import { useMediasoupParticipants } from '../../hooks/mediasoup/useMediasoupParticipants';
import { useMediasoupPeerVolume } from '../../hooks/mediasoup/useMediasoupPeerVolume';
import { useMediasoupScreenShares } from '../../hooks/mediasoup/useMediasoupScreenShares';
import { useMediasoupTalkControls } from '../../hooks/mediasoup/useMediasoupTalkControls';
import styles from '../RoomPage.module.css';

interface Props {
  roomId: string;
  peerId: string;
  displayName: string;
  onLeaveIntent: () => void;
  onChangeTransport: (mode: TransportMode) => void;
}

type PanelWidthStyle = CSSProperties & {
  '--sidebar-width': string;
  '--chat-width': string;
};

/**
 * Sala completa no transporte mediasoup — mesma UI e as mesmas features de
 * `RoomShell` (LiveKit): participantes, câmera, tela compartilhada, chat e
 * soundboard, volume por participante, ausência, tema, canal.
 *
 * Reaproveita os MESMOS componentes visuais de `RoomShell` (eles já eram
 * desacoplados do LiveKit); o que é próprio daqui são os hooks
 * `hooks/mediasoup/*`, construídos sobre `MediasoupConnection` em vez do
 * `Room` do livekit-client — ver `mediasoupConnection.ts` para o porquê de
 * serem dois caminhos separados, sem código compartilhado entre eles.
 *
 * ## O que FICA DE FORA deste v1 (documentado, não esquecido)
 *
 * - **Moderação** de OUTROS participantes a partir DESTA sala (não existe
 *   botão de mutar/mover/remover alguém daqui, ao contrário do LiveKit) —
 *   isso só existe no painel admin. O que este componente FAZ ter é o lado
 *   de quem RECEBE um comando do painel: `useMediasoupEngine.forceMuted`
 *   (mic pausado à força) e `onForceMoved` (redireciona para a sala que o
 *   admin escolheu), ambos cooperativos — ver `MediasoupModerationService`
 *   no backend para o porquê de o SFU não impor isso sozinho.
 * - **Gamificação e log de auditoria** (`useRoomGamification`,
 *   `useActivityReporter`): o relatório de atividade usa o TOKEN do LiveKit
 *   como credencial (`sendActivityEvents(participantToken, …)`), que não
 *   existe neste transporte.
 * - **"Quem está falando" (`isSpeaking`) por nível de áudio de verdade**: o
 *   LiveKit calcula isso no servidor; o mediasoup-sfu ainda não expõe essa
 *   métrica. O destaque ainda acende ao soltar um som do soundboard (ver
 *   `useSoundboardSpeakers`), que não depende dela.
 * - **Ausência (`away`) sincronizada com os outros**: fica local a este
 *   navegador (ver `useMediasoupAway`) até o roster carregar um campo de
 *   atributo livre por participante.
 * - **Troca de qualidade de tela em pleno compartilhamento**: o SFU publica
 *   com um perfil de bitrate fixo por ora (ver `useMediasoupScreenShares`).
 */
export function MediasoupRoomShell({
  roomId,
  peerId,
  displayName,
  onLeaveIntent,
  onChangeTransport,
}: Props): JSX.Element {
  const navigate = useNavigate();
  const { toasts, push, dismiss } = useToasts();
  const onForceMoved = useCallback(
    (destino: string) => {
      push('info', `Um administrador moveu você para a sala "${destino}".`);
      navigate(`/sala/${destino}`);
    },
    [navigate, push],
  );
  const engine = useMediasoupEngine({ roomId, peerId, displayName, onForceMoved });
  const status = useMediasoupConnectionStatus(engine);
  const participants = useMediasoupParticipants(engine, peerId, displayName);
  const peerVolume = useMediasoupPeerVolume(engine);
  const channelNav = useChannelNav(roomId);
  const shares = useMediasoupScreenShares(engine, peerId, push);
  const cameras = useMediasoupCameras(engine, peerId, push);
  const talk = useMediasoupTalkControls(engine, (message) => push('error', message));
  const sound = useSoundVolume();
  const { status: authStatus } = useAuth();

  const roomSounds = useRoomSounds({
    roomId,
    isSignedIn: authStatus === 'autenticado',
    notify: push,
  });
  const soundboardSpeakers = useSoundboardSpeakers();
  const { messages, unread, sendChat, playSound, playing, stopSound, markRead } = useMediasoupChat(
    engine.connection,
    peerId,
    displayName,
    () => sound.effective,
    roomSounds.find,
    soundboardSpeakers.mark,
  );
  /*
   * O mediasoup ainda não calcula "quem está falando" de verdade (ver nota no
   * topo deste arquivo) — mas soltar um som do soundboard pode acender o
   * mesmo destaque, do mesmo jeito que no LiveKit.
   */
  const participantsWithSoundboard = participants.map((participant) =>
    soundboardSpeakers.speaking.has(participant.identity)
      ? { ...participant, isSpeaking: true }
      : participant,
  );

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [screenQualityId] = useState<ScreenQualityId>(readScreenQuality);
  const [isSoundboardOpen, setIsSoundboardOpen] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isParticipantsOpen, setIsParticipantsOpen] = useState(readParticipantsOpen);
  const [isRoomPanelOpen, setIsRoomPanelOpen] = useState(false);
  const [themeId, setThemeId] = useState<ThemeId>(readTheme);
  const overlay = useOverlay();

  const controlsRef = useRef<HTMLDivElement | null>(null);
  const identityRef = useRef<HTMLDivElement | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const sidebar = useResizablePanel(mainRef, {
    name: 'sidebar',
    side: 'left',
    label: 'Redimensionar a lista de participantes',
    min: 208,
    max: 440,
    initial: 268,
  });
  const chatPanel = useResizablePanel(mainRef, {
    name: 'chat',
    side: 'right',
    label: 'Redimensionar o chat',
    min: 260,
    max: 560,
    initial: 320,
  });

  const local = participants.find((participant) => participant.isLocal) ?? null;
  const isMicrophoneEnabled = local?.isMicrophoneEnabled ?? false;

  const away = useMediasoupAway({
    isMicrophoneEnabled,
    isCameraOn: cameras.isLocalOn,
    silenceMicrophone: talk.silence,
    stopCamera: cameras.stop,
  });

  // Chat e soundboard contam no instante do clique, igual ao RoomShell.
  const sendChatTracked = useCallback(
    (body: string) => {
      if (body.trim() !== '') trackEvent({ type: 'chat.send' });
      sendChat(body);
    },
    [sendChat],
  );
  const playSoundTracked = useCallback(
    (soundId: string) => {
      trackSoundPlayed();
      playSound(soundId);
    },
    [playSound],
  );

  useEffect(() => {
    applyTheme(themeId);
  }, [themeId]);

  useEffect(() => {
    if (isChatOpen) markRead();
  }, [isChatOpen, messages.length, markRead]);

  // Mostra o erro de conexão do engine como toast, uma vez por ocorrência.
  useEffect(() => {
    if (engine.error !== null) {
      push('error', engine.error);
      engine.clearError();
    }
  }, [engine, push]);

  // Mic pausado à força pelo painel admin — avisa uma vez, a própria conexão
  // já cuidou de silenciar o producer (ver `mediasoupConnection.applyAdminCommand`).
  const wasForceMuted = useRef(false);
  useEffect(() => {
    if (engine.forceMuted && !wasForceMuted.current) {
      push('error', 'Um administrador silenciou seu microfone nesta sala.');
    }
    wasForceMuted.current = engine.forceMuted;
  }, [engine.forceMuted, push]);

  const leave = useCallback(() => {
    onLeaveIntent();
  }, [onLeaveIntent]);

  const mainStyle: PanelWidthStyle = {
    '--sidebar-width': `${sidebar.width}px`,
    '--chat-width': `${chatPanel.width}px`,
  };

  return (
    <>
      <AmbientGradient variant="subtle" />

      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.identity} ref={identityRef}>
            <span className={styles.brand}>Telecord</span>
            <h1 className={styles.title}>
              <button
                type="button"
                className={styles.titleButton}
                onClick={() => setIsRoomPanelOpen((open) => !open)}
                aria-expanded={isRoomPanelOpen}
                title="Nome, descrição e quem participa desta sala"
              >
                {roomId}
              </button>
            </h1>
            {isRoomPanelOpen ? (
              <RoomPanel
                roomId={roomId}
                anchorRef={identityRef}
                onClose={() => setIsRoomPanelOpen(false)}
              />
            ) : null}
          </div>
          <div className={styles.headerRight}>
            <TransportPicker
              value="mediasoup"
              compact
              onChange={(mode) => {
                if (mode === 'mediasoup') return;
                onLeaveIntent();
                onChangeTransport(mode);
              }}
            />
            <ConnectionBanner status={status} />
            <GamificationCenter />
          </div>
        </header>

        {channelNav.channel !== null ? (
          <ChannelNav channel={channelNav.channel} currentRoomSlug={roomId} />
        ) : null}

        <MediasoupAudioPlaybackGate blocked={peerVolume.audioBlocked} onUnblock={peerVolume.unblockAudio} />

        <div
          ref={mainRef}
          className={`${styles.main} ${sidebar.isResizing || chatPanel.isResizing ? styles.resizing : ''}`}
          style={mainStyle}
        >
          {isParticipantsOpen ? (
            <>
              <ParticipantSidebar
                participants={participantsWithSoundboard}
                isAway={away.isAway}
                isAwayBusy={away.isBusy}
                onToggleAway={away.toggle}
                peerVolume={peerVolume}
                onClose={() => {
                  setIsParticipantsOpen(false);
                  writeParticipantsOpen(false);
                }}
              />
              <div className={styles.resizer} {...sidebar.handleProps}>
                <span className={styles.grip} aria-hidden="true" />
              </div>
            </>
          ) : null}
          <div className={styles.stageArea}>
            <CameraStrip
              entries={cameras.entries}
              expanded={shares.entries.length === 0}
              roomId={roomId}
              viewerIdentity={peerId}
            />
            {shares.entries.length > 0 || cameras.entries.length === 0 ? (
              <ScreenStage entries={shares.entries} roomId={roomId} viewerIdentity={peerId} />
            ) : null}
          </div>
          {isChatOpen ? (
            <>
              <div
                className={`${styles.resizer} ${styles.resizerChat}`}
                {...chatPanel.handleProps}
              >
                <span className={styles.grip} aria-hidden="true" />
              </div>
              <ChatPanel
                messages={messages}
                onSend={sendChatTracked}
                onClose={() => setIsChatOpen(false)}
                peerVolume={peerVolume}
              />
            </>
          ) : null}
        </div>

        <div className={styles.controls} ref={controlsRef}>
          {isSettingsOpen ? (
            <DeviceSettings
              containerRef={controlsRef}
              talkMode={talk.mode}
              onChangeTalkMode={talk.setMode}
              onClose={() => setIsSettingsOpen(false)}
              notify={push}
              screenQualityId={screenQualityId}
              isSharingScreen={shares.isLocalSharing}
              themeId={themeId}
              onChangeTheme={(id) => {
                setThemeId(id);
                writeTheme(id);
              }}
              isOverlaySupported={overlay.isSupported}
              isOverlayOpen={overlay.isOpen}
              onToggleOverlay={overlay.toggle}
              onChangeScreenQuality={(id) => {
                writeScreenQuality(id);
                // Sem restart em pleno compartilhamento neste v1 — ver nota
                // no topo do arquivo.
              }}
            />
          ) : null}

          {isSoundboardOpen ? (
            <Soundboard
              containerRef={controlsRef}
              sounds={roomSounds.sounds}
              isLoading={roomSounds.isLoading}
              error={roomSounds.error}
              canUpload={roomSounds.canUpload}
              isUploading={roomSounds.isUploading}
              onUpload={(files) => void roomSounds.upload(files)}
              onDelete={(soundId) => void roomSounds.remove(soundId)}
              onPlay={playSoundTracked}
              playing={playing}
              onStop={stopSound}
              onClose={() => setIsSoundboardOpen(false)}
              volume={sound.volume}
              muted={sound.muted}
              onVolumeChange={sound.setVolume}
              onToggleMute={sound.toggleMuted}
            />
          ) : null}

          <ControlBar
            talkMode={talk.mode}
            isMicrophoneEnabled={talk.isMicOn}
            isMicrophoneBusy={engine.forceMuted}
            onToggleMicrophone={talk.toggleOpenMic}
            onPressToTalk={talk.pressToTalk}
            onReleaseToTalk={talk.releaseToTalk}
            isCameraOn={cameras.isLocalOn}
            cameraDisabledReason={cameras.disabledReason}
            onToggleCamera={cameras.isLocalOn ? cameras.stop : cameras.start}
            isSharingScreen={shares.isLocalSharing}
            shareDisabledReason={shares.disabledReason}
            onToggleScreenShare={
              shares.isLocalSharing ? shares.stop : () => shares.start(screenQualityId)
            }
            isSoundboardOpen={isSoundboardOpen}
            onToggleSoundboard={() => {
              setIsSoundboardOpen((open) => !open);
              setIsSettingsOpen(false);
            }}
            isParticipantsOpen={isParticipantsOpen}
            onToggleParticipants={() => {
              setIsParticipantsOpen((open) => {
                writeParticipantsOpen(!open);
                return !open;
              });
            }}
            isChatOpen={isChatOpen}
            unreadCount={unread}
            onToggleChat={() => setIsChatOpen((open) => !open)}
            isSettingsOpen={isSettingsOpen}
            onToggleSettings={() => {
              setIsSettingsOpen((open) => !open);
              setIsSoundboardOpen(false);
            }}
            onLeave={leave}
            disabled={status !== 'connected'}
          />
        </div>

        <ParticipantOverlay
          container={overlay.container}
          roomId={roomId}
          people={participantsWithSoundboard.map((p) => ({
            id: p.identity,
            displayName: p.displayName,
            isSpeaking: p.isSpeaking,
            isMuted: !p.isMicrophoneEnabled,
            isLocal: p.isLocal,
            isAway: p.isAway,
          }))}
        />

        <ToastStack toasts={toasts} onDismiss={dismiss} />
      </div>
    </>
  );
}
