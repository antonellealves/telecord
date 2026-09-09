import { LeaveIcon, MicIcon, MicOffIcon, ScreenIcon, SlidersIcon } from './icons';
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
  isSettingsOpen: boolean;
  onToggleSettings: () => void;
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
  isSettingsOpen,
  onToggleSettings,
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

      {/* Fica habilitado mesmo desconectado: escolher dispositivo enquanto a
          sala reconecta é justamente quando isso costuma ser preciso. */}
      <button
        type="button"
        className={`${styles.button} ${isSettingsOpen ? styles.toggled : ''}`}
        onClick={onToggleSettings}
        aria-expanded={isSettingsOpen}
        aria-haspopup="dialog"
        title="Escolher microfone e saída de áudio"
      >
        <SlidersIcon />
        Dispositivos
      </button>

      <button type="button" className={`${styles.button} ${styles.danger}`} onClick={onLeave}>
        <LeaveIcon />
        Sair
      </button>

      {shareBlocked ? <p className={styles.hint}>{shareDisabledReason}</p> : null}
    </div>
  );
}
