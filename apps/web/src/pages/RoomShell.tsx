import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { RoomAudioRenderer, useRoomContext } from '@livekit/components-react';
import { AmbientGradient } from '../components/AmbientGradient';
import { AudioPlaybackGate } from '../components/AudioPlaybackGate';
import { CameraStrip } from '../components/CameraStrip';
import { ChatPanel } from '../components/ChatPanel';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { ControlBar } from '../components/ControlBar';
import { DeviceSettings } from '../components/DeviceSettings';
import { ParticipantSidebar } from '../components/ParticipantSidebar';
import { ScreenStage } from '../components/ScreenStage';
import { Soundboard } from '../components/Soundboard';
import { ToastStack } from '../components/ToastStack';
import { useAway } from '../hooks/useAway';
import { useCameras } from '../hooks/useCameras';
import { useParticipantViews } from '../hooks/useParticipantViews';
import { useResizablePanel } from '../hooks/useResizablePanel';
import { useRoomConnectionStatus } from '../hooks/useRoomConnection';
import { useRoomMessages } from '../hooks/useRoomMessages';
import { useScreenShares } from '../hooks/useScreenShares';
import { useSoundVolume } from '../hooks/useSoundVolume';
import { useTalkControls } from '../hooks/useTalkControls';
import { useToasts } from '../hooks/useToasts';
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
  const { toasts, push, dismiss } = useToasts();
  const shares = useScreenShares(push);
  const cameras = useCameras(push);
  const talk = useTalkControls((message) => push('error', message));
  const sound = useSoundVolume();
  const { messages, unread, sendChat, playSound, playing, stopSound, markRead } =
    useRoomMessages(() => sound.effective);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSoundboardOpen, setIsSoundboardOpen] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);

  const controlsRef = useRef<HTMLDivElement | null>(null);
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
          <div className={styles.identity}>
            <span className={styles.brand}>Telecord</span>
            <h1 className={styles.title}>{roomId}</h1>
          </div>
          <ConnectionBanner status={status} />
        </header>

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
            />
          ) : null}

          {isSoundboardOpen ? (
            <Soundboard
              containerRef={controlsRef}
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
            onToggleScreenShare={shares.isLocalSharing ? shares.stop : shares.start}
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
