import { useEffect, useRef, useState, type RefObject } from 'react';
import { useMediaDevices } from '../hooks/useMediaDevices';
import { useMicrophoneTest } from '../hooks/useMicrophoneTest';
import type { ToastKind } from '../hooks/useToasts';
import {
  screenQuality,
  SCREEN_QUALITY_OPTIONS,
  type ScreenQualityId,
} from '../lib/media';
import type { TalkMode, ThemeId } from '../lib/storage';
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
  themeId: ThemeId;
  onChangeTheme: (id: ThemeId) => void;
  /** O navegador tem a janela flutuante? Sem isso o controle explica. */
  isOverlaySupported: boolean;
  isOverlayOpen: boolean;
  onToggleOverlay: () => void;
}

/*
 * Três seções, e a divisão segue o MOTIVO de alguém abrir o painel: ajustar
 * como se fala, como se transmite, ou trocar um aparelho que acabou de ser
 * plugado. Microfone e saída aparecem em Dispositivos, que é onde se procura
 * por eles — o modo de voz fica em Áudio, porque é comportamento, não
 * hardware.
 */
type Section = 'audio' | 'video' | 'dispositivos' | 'aparencia';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'audio', label: 'Áudio' },
  { id: 'video', label: 'Vídeo' },
  { id: 'dispositivos', label: 'Dispositivos' },
  { id: 'aparencia', label: 'Aparência' },
];

const TEMAS: { id: ThemeId; label: string; hint: string }[] = [
  { id: 'escuro', label: 'Escuro', hint: 'O padrão: carvão frio com azul e roxo.' },
  { id: 'claro', label: 'Claro', hint: 'Fundo claro, acento azul escurecido para contraste.' },
  { id: 'livekit', label: 'LiveKit', hint: 'O azul do padrão mais saturado e mais frio.' },
  { id: 'direta', label: 'Conexão direta', hint: 'A paleta âmbar da sala P2P no app inteiro.' },
];

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
  themeId,
  onChangeTheme,
  isOverlaySupported,
  isOverlayOpen,
  onToggleOverlay,
}: DeviceSettingsProps): JSX.Element {
  const [section, setSection] = useState<Section>('audio');
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
      /*
       * "Dentro" é o container OU o próprio painel.
       *
       * O painel é filho do container hoje, mas depender disso era o bug:
       * bastava alguém mover o painel para outro lugar da árvore para ele
       * passar a fechar sozinho. Checar os dois torna a regra explícita.
       */
      const alvo = event.target;
      if (!(alvo instanceof Node)) return;

      const container = containerRef.current;
      const painel = panelRef.current;
      if (container?.contains(alvo) === true) return;
      if (painel?.contains(alvo) === true) return;

      /*
       * O MENU NATIVO DE UM <select> NÃO É DOM.
       *
       * Ele é desenhado pelo sistema operacional, fora da página, então
       * escolher uma opção dispara `pointerdown` num alvo que não está dentro
       * de container nenhum — e o painel fechava antes de a escolha valer.
       * Era isto que quebrava escolher microfone, câmera, saída e qualidade.
       *
       * Enquanto o foco está num `<select>`, qualquer clique fora é
       * interação com o menu dele, e não vontade de fechar o painel.
       */
      const focado = document.activeElement;
      if (focado instanceof HTMLSelectElement) return;

      onClose();
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
    <div className={styles.panel} ref={panelRef} role="dialog" aria-label="Configurações">
      <div className={styles.header}>
        <h2 className={styles.heading}>Configurações</h2>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Fechar">
          ×
        </button>
      </div>

      {/*
        * Seções em vez de uma lista só: o painel juntava modo de voz,
        * microfone, saída, câmera e qualidade de transmissão numa rolagem
        * única, e quem vinha trocar o fone passava por tudo.
        */}
      <nav className={styles.sections} role="tablist" aria-label="Seções">
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={section === item.id}
            className={`${styles.sectionTab} ${section === item.id ? styles.sectionTabOn : ''}`}
            onClick={() => setSection(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {section === 'audio' ? (
      <>
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

      </>
      ) : null}

      {section === 'dispositivos' ? (
      <>
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
      </>
      ) : null}

      {section === 'video' ? (
      <>
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
      </>
      ) : null}

      {section === 'aparencia' ? (
      <>
      <div className={styles.field}>
        <span className={styles.label}>Tema</span>
        <div className={styles.themes} role="radiogroup" aria-label="Tema">
          {TEMAS.map((tema) => (
            <button
              key={tema.id}
              type="button"
              role="radio"
              aria-checked={themeId === tema.id}
              className={`${styles.theme} ${themeId === tema.id ? styles.themeOn : ''}`}
              onClick={() => onChangeTheme(tema.id)}
              title={tema.hint}
            >
              {/*
                * A amostra usa os tokens DO TEMA, não os do tema ativo: é o
                * único jeito de a escolha mostrar o que vai acontecer em vez
                * de quatro retângulos iguais.
                */}
              <span className={styles.swatch} data-theme={tema.id === 'escuro' ? undefined : tema.id}>
                <span className={styles.swatchBg} />
                <span className={styles.swatchAccent} />
              </span>
              <span className={styles.themeName}>{tema.label}</span>
            </button>
          ))}
        </div>
        <span className={styles.hint}>{TEMAS.find((t) => t.id === themeId)?.hint}</span>
      </div>

      <div className={styles.field}>
        <label className={styles.switchRow}>
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={isOverlayOpen}
            onChange={onToggleOverlay}
            disabled={!isOverlaySupported}
          />
          <span className={styles.switchTrack} aria-hidden="true">
            <span className={styles.switchThumb} />
          </span>
          <span className={styles.switchLabel}>Overlay de participantes</span>
        </label>
        <span className={styles.hint}>
          {isOverlaySupported
            ? 'Abre uma janela flutuante com quem está na sala e quem está falando. Ela fica acima de qualquer aplicativo, inclusive jogo em tela cheia.'
            : 'Este navegador não tem a janela flutuante de documento. Funciona no Chrome, Edge e Opera de computador, versão 116 ou mais nova.'}
        </span>
      </div>
      </>
      ) : null}
    </div>
  );
}
