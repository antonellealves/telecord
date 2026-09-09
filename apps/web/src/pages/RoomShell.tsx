import { useCallback, useRef, useState, type CSSProperties } from 'react';
import { RoomAudioRenderer, useRoomContext } from '@livekit/components-react';
import { AmbientGradient } from '../components/AmbientGradient';
import { AudioPlaybackGate } from '../components/AudioPlaybackGate';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { ControlBar } from '../components/ControlBar';
import { DeviceSettings } from '../components/DeviceSettings';
import { ParticipantSidebar } from '../components/ParticipantSidebar';
import { ScreenStage } from '../components/ScreenStage';
import { ToastStack } from '../components/ToastStack';
import { useParticipantViews } from '../hooks/useParticipantViews';
import { useResizableSidebar } from '../hooks/useResizableSidebar';
import { useRoomConnectionStatus } from '../hooks/useRoomConnection';
import { useScreenShareLock } from '../hooks/useScreenShareLock';
import { useToasts } from '../hooks/useToasts';
import { describeMicrophoneError } from '../lib/errors';
import styles from './RoomPage.module.css';

interface RoomShellProps {
  roomId: string;
  onLeaveIntent: () => void;
}

type SidebarWidthStyle = CSSProperties & { '--sidebar-width': string };

/** Interior da sala. Só existe dentro do contexto do LiveKitRoom. */
export function RoomShell({ roomId, onLeaveIntent }: RoomShellProps): JSX.Element {
  const room = useRoomContext();
  const status = useRoomConnectionStatus();
  const participants = useParticipantViews();
  const { toasts, push, dismiss } = useToasts();
  const share = useScreenShareLock(push);
  const [isMicrophoneBusy, setIsMicrophoneBusy] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const controlsRef = useRef<HTMLDivElement | null>(null);

  const mainRef = useRef<HTMLDivElement | null>(null);
  const sidebar = useResizableSidebar(mainRef);

  const local = participants.find((participant) => participant.isLocal) ?? null;
  const isMicrophoneEnabled = local?.isMicrophoneEnabled ?? false;

  const toggleMicrophone = useCallback(() => {
    if (isMicrophoneBusy) {
      return;
    }
    setIsMicrophoneBusy(true);
    const next = !room.localParticipant.isMicrophoneEnabled;
    void room.localParticipant
      .setMicrophoneEnabled(next)
      .catch((error: unknown) => {
        push('error', describeMicrophoneError(error));
      })
      .finally(() => setIsMicrophoneBusy(false));
  }, [room, isMicrophoneBusy, push]);

  const leave = useCallback(() => {
    onLeaveIntent();
    void room.disconnect();
  }, [room, onLeaveIntent]);

  // A largura vai como custom property, não como `width` inline: assim o
  // layout empilhado do mobile consegue sobrescrevê-la pelo CSS.
  const mainStyle: SidebarWidthStyle = { '--sidebar-width': `${sidebar.width}px` };

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
          className={`${styles.main} ${sidebar.isResizing ? styles.resizing : ''}`}
          style={mainStyle}
        >
          <ParticipantSidebar participants={participants} />
          <div className={styles.resizer} {...sidebar.handleProps}>
            <span className={styles.grip} aria-hidden="true" />
          </div>
          <ScreenStage entry={share.active} />
        </div>

        <div className={styles.controls} ref={controlsRef}>
          {isSettingsOpen ? (
            <DeviceSettings
              containerRef={controlsRef}
              onClose={() => setIsSettingsOpen(false)}
              notify={push}
            />
          ) : null}

          <ControlBar
            isMicrophoneEnabled={isMicrophoneEnabled}
            isMicrophoneBusy={isMicrophoneBusy}
            onToggleMicrophone={toggleMicrophone}
            isSharingScreen={share.isLocalOwner}
            shareDisabledReason={share.disabledReason}
            onToggleScreenShare={share.isLocalOwner ? share.stop : share.start}
            onLeave={leave}
            disabled={status !== 'connected'}
            isSettingsOpen={isSettingsOpen}
            onToggleSettings={() => setIsSettingsOpen((open) => !open)}
          />
        </div>

        <ToastStack toasts={toasts} onDismiss={dismiss} />
      </div>
    </>
  );
}
