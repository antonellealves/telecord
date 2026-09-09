import { LeaveIcon, MicIcon, MicOffIcon, ScreenIcon } from './icons';
import styles from './ControlBar.module.css';

interface ControlBarProps {
  isMicrophoneEnabled: boolean;
  isMicrophoneBusy: boolean;
  onToggleMicrophone: () => void;
  isSharingScreen: boolean;
  shareDisabledReason: string | null;
  onToggleScreenShare: () => void;
  onLeave: () => void;
  disabled: boolean;
}

export function ControlBar({
  isMicrophoneEnabled,
  isMicrophoneBusy,
  onToggleMicrophone,
  isSharingScreen,
  shareDisabledReason,
  onToggleScreenShare,
  onLeave,
  disabled,
}: ControlBarProps): JSX.Element {
  const shareBlocked = !isSharingScreen && shareDisabledReason !== null;

  return (
    <div className={styles.bar}>
      <button
        type="button"
        className={`${styles.button} ${isMicrophoneEnabled ? styles.active : ''}`}
        onClick={onToggleMicrophone}
        disabled={disabled || isMicrophoneBusy}
        aria-pressed={isMicrophoneEnabled}
        title={isMicrophoneEnabled ? 'Desligar o microfone' : 'Ligar o microfone'}
      >
        {isMicrophoneEnabled ? <MicIcon /> : <MicOffIcon />}
        {isMicrophoneEnabled ? 'Microfone ligado' : 'Falar'}
      </button>

      <button
        type="button"
        className={`${styles.button} ${isSharingScreen ? styles.active : ''}`}
        onClick={onToggleScreenShare}
        disabled={disabled || shareBlocked}
        title={shareDisabledReason ?? (isSharingScreen ? 'Parar de compartilhar' : 'Compartilhar tela')}
      >
        <ScreenIcon />
        {isSharingScreen ? 'Parar de compartilhar' : 'Compartilhar tela'}
      </button>

      <button type="button" className={`${styles.button} ${styles.danger}`} onClick={onLeave}>
        <LeaveIcon />
        Sair
      </button>

      {shareBlocked ? <p className={styles.hint}>{shareDisabledReason}</p> : null}
    </div>
  );
}
