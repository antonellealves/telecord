import type { PointerEvent as ReactPointerEvent } from 'react';
import type { TalkMode } from '../lib/storage';
import { LeaveIcon, MicIcon, MicOffIcon, ScreenIcon, SlidersIcon } from './icons';
import styles from './ControlBar.module.css';

interface ControlBarProps {
  talkMode: TalkMode;
  isMicrophoneEnabled: boolean;
  isMicrophoneBusy: boolean;
  onToggleMicrophone: () => void;
  onPressToTalk: () => void;
  onReleaseToTalk: () => void;
  isSharingScreen: boolean;
  shareDisabledReason: string | null;
  onToggleScreenShare: () => void;
  onLeave: () => void;
  disabled: boolean;
  isSettingsOpen: boolean;
  onToggleSettings: () => void;
}

export function ControlBar({
  talkMode,
  isMicrophoneEnabled,
  isMicrophoneBusy,
  onToggleMicrophone,
  onPressToTalk,
  onReleaseToTalk,
  isSharingScreen,
  shareDisabledReason,
  onToggleScreenShare,
  onLeave,
  disabled,
  isSettingsOpen,
  onToggleSettings,
}: ControlBarProps): JSX.Element {
  const shareBlocked = !isSharingScreen && shareDisabledReason !== null;

  // Captura o ponteiro: sem isso, arrastar um pouco para fora do botão dispara
  // pointerleave e corta a transmissão no meio da frase.
  const handlePressDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    onPressToTalk();
  };

  const handlePressUp = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onReleaseToTalk();
  };

  return (
    <div className={styles.bar}>
      {talkMode === 'push' ? (
        /*
         * Em push o botão NÃO é desabilitado enquanto a troca está em curso:
         * botão desabilitado no meio do gesto não recebe o pointerup, e o
         * microfone ficaria aberto.
         */
        <button
          type="button"
          className={`${styles.button} ${isMicrophoneEnabled ? styles.active : ''}`}
          onPointerDown={handlePressDown}
          onPointerUp={handlePressUp}
          onPointerCancel={handlePressUp}
          onContextMenu={(event) => event.preventDefault()}
          disabled={disabled}
          aria-pressed={isMicrophoneEnabled}
          title="Segure para falar — ou segure a barra de espaço"
        >
          {isMicrophoneEnabled ? <MicIcon /> : <MicOffIcon />}
          {isMicrophoneEnabled ? 'Falando…' : 'Segure para falar'}
        </button>
      ) : (
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
      )}

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
        title="Modo de voz, dispositivos e teste de microfone"
      >
        <SlidersIcon />
        Áudio
      </button>

      <button type="button" className={`${styles.button} ${styles.danger}`} onClick={onLeave}>
        <LeaveIcon />
        Sair
      </button>

      {shareBlocked ? <p className={styles.hint}>{shareDisabledReason}</p> : null}
      {!shareBlocked && talkMode === 'push' ? (
        <p className={styles.hint}>
          Aperte para falar: segure a <kbd className={styles.kbd}>barra de espaço</kbd> ou o botão.
        </p>
      ) : null}
    </div>
  );
}
