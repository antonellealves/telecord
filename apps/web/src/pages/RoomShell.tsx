import { useCallback, useState } from 'react';
import { RoomAudioRenderer, useRoomContext } from '@livekit/components-react';
import { AudioPlaybackGate } from '../components/AudioPlaybackGate';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { ControlBar } from '../components/ControlBar';
import { ParticipantSidebar } from '../components/ParticipantSidebar';
import { ScreenStage } from '../components/ScreenStage';
import { ToastStack } from '../components/ToastStack';
import { useParticipantViews } from '../hooks/useParticipantViews';
import { useRoomConnectionStatus } from '../hooks/useRoomConnection';
import { useScreenShareLock } from '../hooks/useScreenShareLock';
import { useToasts } from '../hooks/useToasts';
import { describeMicrophoneError } from '../lib/errors';
import styles from './RoomPage.module.css';

interface RoomShellProps {
  roomId: string;
  onLeaveIntent: () => void;
}

/** Interior da sala. Só existe dentro do contexto do LiveKitRoom. */
export function RoomShell({ roomId, onLeaveIntent }: RoomShellProps): JSX.Element {
  const room = useRoomContext();
  const status = useRoomConnectionStatus();
  const participants = useParticipantViews();
  const { toasts, push, dismiss } = useToasts();
  const share = useScreenShareLock(push);
  const [isMicrophoneBusy, setIsMicrophoneBusy] = useState(false);

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

  return (
    <div className={styles.shell}>
      {/* Sem isto ninguém ouve nada — e a falha é silenciosa. */}
      <RoomAudioRenderer />

      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Sala</p>
          <h1 className={styles.title}>{roomId}</h1>
        </div>
        <ConnectionBanner status={status} />
      </header>

      <AudioPlaybackGate />

      <div className={styles.main}>
        <ScreenStage entry={share.active} />
        <ParticipantSidebar participants={participants} />
      </div>

      <ControlBar
        isMicrophoneEnabled={isMicrophoneEnabled}
        isMicrophoneBusy={isMicrophoneBusy}
        onToggleMicrophone={toggleMicrophone}
        isSharingScreen={share.isLocalOwner}
        shareDisabledReason={share.disabledReason}
        onToggleScreenShare={share.isLocalOwner ? share.stop : share.start}
        onLeave={leave}
        disabled={status !== 'connected'}
      />

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
