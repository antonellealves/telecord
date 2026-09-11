import { useEffect, useRef, type RefObject } from 'react';
import { useMediaDevices } from '../hooks/useMediaDevices';
import { useMicrophoneTest } from '../hooks/useMicrophoneTest';
import type { ToastKind } from '../hooks/useToasts';
import {
  screenQuality,
  SCREEN_QUALITY_OPTIONS,
  type ScreenQualityId,
} from '../lib/media';
import type { TalkMode } from '../lib/storage';
import { MicIcon, ScreenIcon, SpeakerIcon } from './icons';
import styles from './DeviceSettings.module.css';

interface DeviceSettingsProps {
  /**
   * Região que conta como "dentro". Precisa englobar o botão que abre o
   * painel: se ele ficasse de fora, o mesmo gesto fecharia pelo clique-fora e
   * reabriria pelo clique no botão, e o painel pareceria travado aberto.
   */
  containerRef: RefObject<HTMLElement | null>;
  talkMode: TalkMode;
  onChangeTalkMode: (mode: TalkMode) => void;
  onClose: () => void;
  notify: (kind: ToastKind, message: string) => void;
  screenQualityId: ScreenQualityId;
  onChangeScreenQuality: (id: ScreenQualityId) => void;
  /** Muda o texto de ajuda: trocar agora republica em vez de esperar. */
  isSharingScreen: boolean;
}

const TEST_LABEL: Record<'idle' | 'recording' | 'playing', string> = {
  idle: 'Testar',
  recording: 'Gravando…',
  playing: 'Tocando…',
};

/** Painel de mídia: modo de voz, dispositivos, teste de microfone e qualidade da tela. */
export function DeviceSettings({
  containerRef,
  talkMode,
  onChangeTalkMode,
  onClose,
  notify,
  screenQualityId,
  onChangeScreenQuality,
  isSharingScreen,
}: DeviceSettingsProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const devices = useMediaDevices((message) => notify('error', message));
  const test = useMicrophoneTest(
    () => devices.activeAudioOutput,
    (message) => notify('error', message),
  );

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
    <div className={styles.panel} ref={panelRef} role="dialog" aria-label="Áudio e vídeo">
      <div className={styles.header}>
        <h2 className={styles.heading}>Áudio e vídeo</h2>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Fechar">
          ×
        </button>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>
          <MicIcon className={styles.icon} />
          Modo de voz
        </span>
        <div className={styles.segmented} role="radiogroup" aria-label="Modo de voz">
          <button
            type="button"
            role="radio"
            aria-checked={talkMode === 'open'}
            className={`${styles.segment} ${talkMode === 'open' ? styles.segmentOn : ''}`}
            onClick={() => onChangeTalkMode('open')}
          >
            Voz aberta
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={talkMode === 'push'}
            className={`${styles.segment} ${talkMode === 'push' ? styles.segmentOn : ''}`}
            onClick={() => onChangeTalkMode('push')}
          >
            Aperte para falar
          </button>
        </div>
        <span className={styles.hint}>
          {talkMode === 'open'
            ? 'O microfone fica ligado até você desligar.'
            : 'Segure a barra de espaço, ou o botão da barra, para transmitir.'}
        </span>
      </div>

      {devices.labelsHidden ? (
        <p className={styles.notice}>
          O navegador esconde o nome dos dispositivos até você autorizar o microfone.
          <button type="button" className={styles.link} onClick={devices.revealLabels}>
            Mostrar os nomes
          </button>
        </p>
      ) : null}

      <div className={styles.field}>
        <span className={styles.label}>
          <MicIcon className={styles.icon} />
          Microfone
        </span>
        <select
          className={styles.select}
          value={devices.activeAudioInput}
          disabled={devices.isSwitching || devices.audioInputs.length === 0}
          onChange={(event) => devices.selectAudioInput(event.target.value)}
          aria-label="Microfone"
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

        {test.supported ? (
          <div className={styles.testRow}>
            <button
              type="button"
              className={`${styles.testButton} ${test.state !== 'idle' ? styles.testButtonOn : ''}`}
              onClick={test.state === 'idle' ? test.start : test.cancel}
            >
              {test.state === 'recording'
                ? `${TEST_LABEL.recording} ${test.secondsLeft}s`
                : TEST_LABEL[test.state]}
            </button>
            <div className={styles.meter} ref={test.meterRef} aria-hidden="true">
              <div className={styles.meterFill} />
            </div>
          </div>
        ) : null}

        <span className={styles.hint}>
          {test.state === 'recording'
            ? 'Fale normalmente — a barra mostra o que está entrando.'
            : test.state === 'playing'
              ? 'Tocando a gravação pela saída escolhida abaixo.'
              : 'O teste grava alguns segundos e toca de volta, sem abrir o microfone da sala.'}
        </span>
      </div>

      <div className={styles.field}>
        <label className={styles.switchRow}>
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={devices.noiseSuppression}
            onChange={(event) => devices.setNoiseSuppression(event.target.checked)}
          />
          <span className={styles.switchTrack} aria-hidden="true">
            <span className={styles.switchThumb} />
          </span>
          <span className={styles.switchLabel}>Supressão de ruído</span>
        </label>
        <span className={styles.hint}>
          Corta ventilador, teclado e barulho de fundo. Desligue se estiver tocando ou cantando —
          o filtro trata música como ruído.
        </span>
      </div>

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

      <label className={styles.field}>
        <span className={styles.label}>
          <ScreenIcon className={styles.icon} />
          Câmera
        </span>
        <select
          className={styles.select}
          value={devices.activeVideoInput}
          disabled={devices.isSwitching || devices.videoInputs.length === 0}
          onChange={(event) => devices.selectVideoInput(event.target.value)}
          aria-label="Câmera"
        >
          {devices.videoInputs.length === 0 ? (
            <option value="default">Nenhuma câmera encontrada</option>
          ) : (
            devices.videoInputs.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))
          )}
        </select>
        <span className={styles.hint}>
          Câmera e tela compartilhada são independentes: dá para mostrar as duas ao mesmo tempo.
          A janela ou monitor compartilhado quem escolhe é o seletor do próprio navegador.
        </span>
      </label>

      <label className={styles.field}>
        <span className={styles.label}>
          <ScreenIcon className={styles.icon} />
          Qualidade da transmissão
        </span>
        <select
          className={styles.select}
          value={screenQualityId}
          onChange={(event) => onChangeScreenQuality(event.target.value as ScreenQualityId)}
          aria-label="Qualidade da transmissão de tela"
        >
          {SCREEN_QUALITY_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <span className={styles.hint}>
          {screenQuality(screenQualityId).hint}
          {' '}
          {/*
            * O texto muda com o estado porque a consequência muda: com uma
            * transmissão no ar, trocar republica na hora e o quadro pisca;
            * sem transmissão, a escolha fica guardada para a próxima.
            */}
          {isSharingScreen
            ? 'Trocar agora republica a tela — o quadro pisca uma vez para quem assiste.'
            : 'Vale a partir do próximo compartilhamento.'}
        </span>
      </label>
    </div>
  );
}
