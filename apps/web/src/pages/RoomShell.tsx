import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { RoomAudioRenderer, useRoomContext } from '@livekit/components-react';
import { AmbientGradient } from '../components/AmbientGradient';
import { AudioPlaybackGate } from '../components/AudioPlaybackGate';
import { CameraStrip } from '../components/CameraStrip';
import { ChannelNav } from '../components/ChannelNav';
import { ChatPanel } from '../components/ChatPanel';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { ControlBar } from '../components/ControlBar';
import { DeviceSettings } from '../components/DeviceSettings';
import { ParticipantSidebar } from '../components/ParticipantSidebar';
import { RoomPanel } from '../components/RoomPanel';
import { ScreenStage } from '../components/ScreenStage';
import { Soundboard } from '../components/Soundboard';
import { ToastStack } from '../components/ToastStack';
import { useAuth } from '../hooks/useAuth';
import { useAway } from '../hooks/useAway';
import { useCameras } from '../hooks/useCameras';
import { useChannelNav } from '../hooks/useChannelNav';
import { useParticipantViews } from '../hooks/useParticipantViews';
import { usePeerVolume } from '../hooks/usePeerVolume';
import { useResizablePanel } from '../hooks/useResizablePanel';
import { useRoomConnectionStatus } from '../hooks/useRoomConnection';
import { useRoomMessages } from '../hooks/useRoomMessages';
import { useRoomSounds } from '../hooks/useRoomSounds';
import { useScreenShares } from '../hooks/useScreenShares';
import { useSoundVolume } from '../hooks/useSoundVolume';
import { useTalkControls } from '../hooks/useTalkControls';
import { useToasts } from '../hooks/useToasts';
import type { ScreenQualityId } from '../lib/media';
import { readScreenQuality, writeScreenQuality } from '../lib/storage';
import styles from './RoomPage.module.css';

interface RoomShellProps {
  roomId: string;
  onLeaveIntent: () => void;
}

type PanelWidthStyle = CSSProperties & {
  '--sidebar-width': string;
  '--chat-width': string;
};

/** Interior da sala. Só existe dentro do contexto do LiveKitRoom. */
export function RoomShell({ roomId, onLeaveIntent }: RoomShellProps): JSX.Element {
  const room = useRoomContext();
  const status = useRoomConnectionStatus();
  const participants = useParticipantViews();
  const peerVolume = usePeerVolume();
  const channelNav = useChannelNav(roomId);
  const { toasts, push, dismiss } = useToasts();
  const shares = useScreenShares(push);
  const cameras = useCameras(push);
  const talk = useTalkControls((message) => push('error', message));
  const sound = useSoundVolume();
  const { status: authStatus } = useAuth();
  /*
   * O painel de sons junta o catálogo do build com os que a turma enviou para
   * ESTA sala, e é ele quem resolve o id que chega pelo canal de dados — daí a
   * ordem: os sons primeiro, e o `find` deles entregue ao canal de mensagens.
   */
  const roomSounds = useRoomSounds({
    roomId,
    isSignedIn: authStatus === 'autenticado',
    notify: push,
  });
  const { messages, unread, sendChat, playSound, playing, stopSound, markRead } =
    useRoomMessages(() => sound.effective, roomSounds.find);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  // Preferência de máquina; ver `readScreenQuality`.
  const [screenQualityId, setScreenQualityId] = useState<ScreenQualityId>(readScreenQuality);
  const [isSoundboardOpen, setIsSoundboardOpen] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isRoomPanelOpen, setIsRoomPanelOpen] = useState(false);

  const controlsRef = useRef<HTMLDivElement | null>(null);
  /* Âncora da ficha da sala: engloba o título e o próprio painel. */
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
  const isAway = local?.isAway ?? false;

  const away = useAway({
    isMicrophoneEnabled,
    isCameraOn: cameras.isLocalOn,
    silenceMicrophone: talk.silence,
    stopCamera: cameras.stop,
    onError: (message) => push('error', message),
  });

  // Chat aberto não acumula não-lidas.
  useEffect(() => {
    if (isChatOpen) {
      markRead();
    }
  }, [isChatOpen, messages.length, markRead]);

  const leave = useCallback(() => {
    onLeaveIntent();
    void room.disconnect();
  }, [room, onLeaveIntent]);

  // A largura vai como custom property, não como `width` inline: assim o
  // layout empilhado do mobile consegue sobrescrevê-la pelo CSS.
  const mainStyle: PanelWidthStyle = {
    '--sidebar-width': `${sidebar.width}px`,
    '--chat-width': `${chatPanel.width}px`,
  };

  return (
    <>
      <AmbientGradient variant="subtle" />

      <div className={styles.shell}>
        {/* Sem isto ninguém ouve nada — e a falha é silenciosa. */}
        <RoomAudioRenderer />

        <header className={styles.header}>
          <div className={styles.identity} ref={identityRef}>
            <span className={styles.brand}>Telecord</span>
            {/*
              * O título continua sendo o `h1` da página — a estrutura do
              * documento não muda por causa de um painel. O que abre a ficha é
              * um botão DENTRO dele.
              */}
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
          <ConnectionBanner status={status} />
        </header>

        {channelNav.channel !== null ? (
          <ChannelNav channel={channelNav.channel} currentRoomSlug={roomId} />
        ) : null}

        <AudioPlaybackGate />

        <div
          ref={mainRef}
          className={`${styles.main} ${sidebar.isResizing || chatPanel.isResizing ? styles.resizing : ''}`}
          style={mainStyle}
        >
          <ParticipantSidebar
            participants={participants}
            isAway={isAway}
            isAwayBusy={away.isBusy}
            onToggleAway={away.toggle}
            peerVolume={peerVolume}
          />
          <div className={styles.resizer} {...sidebar.handleProps}>
            <span className={styles.grip} aria-hidden="true" />
          </div>
          <div className={styles.stageArea}>
            <CameraStrip entries={cameras.entries} expanded={shares.entries.length === 0} />
            {shares.entries.length > 0 || cameras.entries.length === 0 ? (
              <ScreenStage entries={shares.entries} />
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
                onSend={sendChat}
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
              onChangeScreenQuality={(id) => {
                setScreenQualityId(id);
                writeScreenQuality(id);
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
              onPlay={playSound}
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
            isMicrophoneEnabled={isMicrophoneEnabled}
            isMicrophoneBusy={talk.isBusy}
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

        <ToastStack toasts={toasts} onDismiss={dismiss} />
      </div>
    </>
  );
}
