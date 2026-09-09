import { useEffect, useRef, type RefObject } from 'react';
import { useMediaDevices } from '../hooks/useMediaDevices';
import type { ToastKind } from '../hooks/useToasts';
import { MicIcon, ScreenIcon, SpeakerIcon } from './icons';
import styles from './DeviceSettings.module.css';

interface DeviceSettingsProps {
  /**
   * Região que conta como "dentro". Precisa englobar o botão que abre o
   * painel: se ele ficasse de fora, o mesmo gesto fecharia pelo clique-fora e
   * reabriria pelo clique no botão, e o painel pareceria travado aberto.
   */
  containerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  notify: (kind: ToastKind, message: string) => void;
}

/** Painel de dispositivos de áudio, ancorado acima da barra de controle. */
export function DeviceSettings({ containerRef, onClose, notify }: DeviceSettingsProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const devices = useMediaDevices((message) => notify('error', message));

  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    const handlePointerDown = (event: PointerEvent): void => {
      const container = containerRef.current;
      if (container !== null && event.target instanceof Node && !container.contains(event.target)) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKey);
    // `pointerdown` e não `click`: fechar no clique deixaria o painel aberto
    // durante todo o arrasto quando o gesto começa fora dele.
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [onClose, containerRef]);

  return (
    <div className={styles.panel} ref={panelRef} role="dialog" aria-label="Dispositivos de áudio">
      <div className={styles.header}>
        <h2 className={styles.heading}>Dispositivos</h2>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Fechar">
          ×
        </button>
      </div>

      {devices.labelsHidden ? (
        <p className={styles.notice}>
          O navegador esconde o nome dos dispositivos até você autorizar o microfone.
          <button type="button" className={styles.link} onClick={devices.revealLabels}>
            Mostrar os nomes
          </button>
        </p>
      ) : null}

      <label className={styles.field}>
        <span className={styles.label}>
          <MicIcon className={styles.icon} />
          Microfone
        </span>
        <select
          className={styles.select}
          value={devices.activeAudioInput}
          disabled={devices.isSwitching || devices.audioInputs.length === 0}
          onChange={(event) => devices.selectAudioInput(event.target.value)}
        >
          {devices.audioInputs.length === 0 ? (
            <option value="default">Nenhum microfone encontrado</option>
          ) : (
            devices.audioInputs.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))
          )}
        </select>
        <span className={styles.hint}>
          Dá para escolher estando mutado: a troca vale quando o microfone for ligado.
        </span>
      </label>

      <label className={styles.field}>
        <span className={styles.label}>
          <SpeakerIcon className={styles.icon} />
          Saída de áudio
        </span>
        {devices.outputSelectionSupported ? (
          <>
            <select
              className={styles.select}
              value={devices.activeAudioOutput}
              disabled={devices.isSwitching || devices.audioOutputs.length === 0}
              onChange={(event) => devices.selectAudioOutput(event.target.value)}
            >
              {devices.audioOutputs.length === 0 ? (
                <option value="default">Nenhuma saída encontrada</option>
              ) : (
                devices.audioOutputs.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))
              )}
            </select>
            <span className={styles.hint}>Para onde o áudio da sala é tocado.</span>
          </>
        ) : (
          <span className={styles.hint}>
            Este navegador não permite escolher a saída — troque pelo sistema operacional.
            Chrome e Edge no computador permitem.
          </span>
        )}
      </label>

      <div className={styles.field}>
        <span className={styles.label}>
          <ScreenIcon className={styles.icon} />
          Vídeo
        </span>
        <span className={styles.hint}>
          A sala não usa câmera: o vídeo é a tela compartilhada, e quem escolhe a janela ou
          monitor é o seletor do próprio navegador, no momento de compartilhar.
        </span>
      </div>
    </div>
  );
}
