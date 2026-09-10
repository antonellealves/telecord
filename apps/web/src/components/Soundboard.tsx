import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type RefObject,
} from 'react';
import { MAX_SOUND_UPLOAD_BYTES } from '@telecord/shared';
import type { PlayableSound } from '../hooks/useRoomSounds';
import type { SoundPlayback } from '../hooks/useRoomMessages';
import { formatSize } from '../lib/soundsApi';
import { InfoIcon, SpeakerIcon, StopIcon, TrashIcon, UploadIcon } from './icons';
import styles from './Soundboard.module.css';

/* Fixo porque só existe um painel de sons por vez na tela. */
const TIP_ID = 'soundboard-tip';

/*
 * Raio do card, copiado de `--radius-sm`. O `<rect>` do progresso precisa dele
 * como atributo, e atributo de SVG não lê variável de CSS. Mexeu num, mexa no
 * outro — senão o traço descola do canto arredondado.
 */
const TILE_RADIUS = 10;

/** O que o seletor de arquivos oferece. O servidor confere pelos bytes. */
const ACCEPT = 'audio/*,.mp3,.ogg,.oga,.opus,.wav,.m4a,.aac,.flac,.webm';

type RingStyle = CSSProperties & { '--sound-duration': string };

interface SoundboardProps {
  /** Região que conta como "dentro" — inclui o botão que abre (ver DeviceSettings). */
  containerRef: RefObject<HTMLElement | null>;
  /** Catálogo do build + os sons enviados para esta sala. */
  sounds: PlayableSound[];
  isLoading: boolean;
  /** Falha ao buscar os sons da sala. Os do build continuam na lista. */
  error: string | null;
  canUpload: boolean;
  isUploading: boolean;
  onUpload: (files: File[]) => void;
  onDelete: (soundId: string) => void;
  onPlay: (soundId: string) => void;
  /** Som tocando agora, ou null. Só um por vez. */
  playing: SoundPlayback | null;
  /** Corta o som para a sala inteira. */
  onStop: (soundId: string) => void;
  onClose: () => void;
  /** 0..1, só para esta pessoa. */
  volume: number;
  muted: boolean;
  onVolumeChange: (volume: number) => void;
  onToggleMute: () => void;
}

/**
 * Sons predefinidos e enviados, tocados para todo mundo na sala.
 *
 * O áudio não trafega pela sala: vai um aviso pelo canal de dados e cada
 * cliente toca o arquivo que tem — do bundle, no caso dos versionados, ou
 * baixado da API e guardado pelo cache do navegador, no caso dos enviados.
 * Mandar o som como áudio custaria banda por ouvinte e chegaria
 * dessincronizado.
 *
 * Parar também é um aviso, não um gesto local: quem corta um clipe longo corta
 * para todos, que é o motivo de existir o botão. Silenciar só para si é o que
 * o controle de volume já faz.
 *
 * Clicar num card sempre dispara o som: em cima de um que já toca, ele
 * recomeça do início em todo mundo. Encerrar é só pelo selo de parar.
 *
 * Cada card leva um emoji na linha de cima. Numa grade de trinta nomes
 * parecidos ele é o que o olho acha primeiro; e é justamente ali que o selo de
 * parar aparece, cobrindo o emoji em vez do nome.
 *
 * Enquanto toca, a própria borda do card se preenche no ritmo do clipe. Quem
 * ouve um som longo quer saber se falta muito antes de decidir cortar — e o
 * traço na borda cabe onde não havia espaço para uma barra.
 *
 * ## Largar arquivo aqui dentro
 *
 * Arrastar um áudio para cima do painel o acrescenta À SALA — não ao
 * repositório. É o caminho de quem quer um clipe hoje à noite sem abrir o
 * projeto. Exige conta, porque o arquivo fica guardado e precisa ter dono para
 * alguém poder apagá-lo depois.
 */
export function Soundboard({
  containerRef,
  sounds,
  isLoading,
  error,
  canUpload,
  isUploading,
  onUpload,
  onDelete,
  onPlay,
  playing,
  onStop,
  onClose,
  volume,
  muted,
  onVolumeChange,
  onToggleMute,
}: SoundboardProps): JSX.Element {
  const [tipOpen, setTipOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  /* Onde ficam o "i" e a dica: clique fora daqui fecha a dica. */
  const tipRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /*
   * `dragenter` e `dragleave` disparam ao atravessar cada filho, então um
   * booleano piscaria a cada card sob o cursor. Contar entradas e saídas é o
   * que faz o realce só apagar quando o ponteiro sai do painel de verdade.
   */
  const dragDepth = useRef(0);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // Uma camada por vez: com a dica aberta, Esc fecha só ela. Fechar o
      // painel inteiro para dispensar um balão de ajuda seria demais.
      if (tipOpen) {
        setTipOpen(false);
        return;
      }
      onClose();
    };
    const handlePointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return;
      if (tipRef.current !== null && !tipRef.current.contains(event.target)) {
        setTipOpen(false);
      }
      const container = containerRef.current;
      if (container !== null && !container.contains(event.target)) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKey);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [onClose, containerRef, tipOpen]);

  const acceptFiles = useCallback(
    (files: FileList | null) => {
      if (files === null || files.length === 0) return;
      onUpload(Array.from(files));
    },
    [onUpload],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragDepth.current = 0;
      setIsDragging(false);
      if (!canUpload) return;
      acceptFiles(event.dataTransfer.files);
    },
    [acceptFiles, canUpload],
  );

  const dragProps = canUpload
    ? {
        onDragEnter: (event: DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          dragDepth.current += 1;
          setIsDragging(true);
        },
        onDragLeave: (event: DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setIsDragging(false);
        },
        // Sem cancelar o `dragover`, o navegador ABRE o arquivo largado e a
        // sala inteira desaparece da tela de quem soltou.
        onDragOver: (event: DragEvent<HTMLDivElement>) => event.preventDefault(),
        onDrop: handleDrop,
      }
    : {};

  return (
    <div
      className={`${styles.panel} ${isDragging ? styles.dropping : ''}`}
      role="dialog"
      aria-label="Sons"
      {...dragProps}
    >
      <div className={styles.header}>
        <div className={styles.title}>
          <h2 className={styles.heading}>Sons</h2>
          {/*
            * Passar o mouse mostra a dica; o clique também, porque em tela de
            * toque não existe passar o mouse. O CSS cuida do hover e do foco,
            * então o estado aqui só existe para o clique.
            */}
          <div
            ref={tipRef}
            className={`${styles.tipAnchor} ${tipOpen ? styles.tipOn : ''}`}
          >
            <button
              type="button"
              className={styles.info}
              onClick={() => setTipOpen((open) => !open)}
              aria-expanded={tipOpen}
              aria-describedby={TIP_ID}
              aria-label="Como acrescentar um som"
            >
              <InfoIcon />
            </button>
            <span id={TIP_ID} role="tooltip" className={styles.tip}>
              {canUpload
                ? 'Largue um arquivo de áudio aqui para acrescentá-lo a esta sala — o nome do arquivo vira o rótulo. Para um som em TODAS as salas, ponha o arquivo em '
                : 'Para acrescentar um som a esta sala, entre com uma conta e largue o arquivo aqui. Para um som em todas as salas, ponha o arquivo em '}
              <code className={styles.code}>apps/web/src/assets/sons</code>.
            </span>
          </div>
        </div>
        <div className={styles.headerActions}>
          {canUpload ? (
            <button
              type="button"
              className={styles.add}
              onClick={() => fileRef.current?.click()}
              disabled={isUploading}
              title={`Acrescentar som a esta sala (até ${formatSize(MAX_SOUND_UPLOAD_BYTES)})`}
              aria-label="Acrescentar som a esta sala"
            >
              <UploadIcon />
            </button>
          ) : null}
          <button type="button" className={styles.close} onClick={onClose} aria-label="Fechar">
            ×
          </button>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        className={styles.file}
        accept={ACCEPT}
        multiple
        onChange={(event) => {
          acceptFiles(event.target.files);
          // Zera o valor: sem isto, escolher o MESMO arquivo de novo não
          // dispara `change` e o envio parece ter sido ignorado.
          event.target.value = '';
        }}
      />

      {error !== null ? <p className={styles.warn}>{error}</p> : null}

      <div className={styles.grid}>
        {sounds.length === 0 ? (
          <p className={styles.empty}>
            {isLoading
              ? 'Carregando os sons desta sala…'
              : canUpload
                ? 'Nenhum som ainda. Largue um arquivo de áudio aqui.'
                : 'Nenhum som instalado.'}
          </p>
        ) : null}
        {sounds.map((sound) => {
          const isPlaying = playing !== null && playing.soundId === sound.id;
          // Sem duração não há o que preencher: o anel pulsante continua sendo
          // o aviso de "tocando" para o clipe cuja duração o navegador não deu.
          const ring = isPlaying && playing.duration !== null ? playing : null;
          return (
            /*
             * O parar é um botão irmão, não filho: botão dentro de botão é HTML
             * inválido e o clique de dentro não chega de forma confiável.
             */
            <div
              key={sound.id}
              className={[styles.tile, isPlaying ? styles.playing : '', ring !== null ? styles.timed : '']
                .filter(Boolean)
                .join(' ')}
            >
              {ring !== null ? (
                /*
                 * `key` no token: redisparar o mesmo som mantém este nó no
                 * lugar, e sem trocar a chave a animação seguiria de onde
                 * estava em vez de recomeçar junto com o áudio.
                 */
                <svg
                  key={ring.token}
                  className={styles.progress}
                  style={{ '--sound-duration': `${ring.duration ?? 0}s` } as RingStyle}
                  aria-hidden="true"
                >
                  <rect
                    className={styles.progressTrack}
                    width="100%"
                    height="100%"
                    rx={TILE_RADIUS}
                  />
                  <rect
                    className={styles.progressLine}
                    width="100%"
                    height="100%"
                    rx={TILE_RADIUS}
                    pathLength="1"
                  />
                </svg>
              ) : null}
              {isPlaying ? (
                <button
                  type="button"
                  className={styles.stop}
                  onClick={() => onStop(sound.id)}
                  title={`Parar "${sound.label}" para todos`}
                  aria-label={`Parar ${sound.label}`}
                >
                  <StopIcon />
                </button>
              ) : null}
              {/*
                * Apagar só aparece em som enviado, e só para quem o servidor
                * disse que pode — quem mandou, quem administra a sala, ou um
                * administrador. Esconder aqui é conveniência; quem decide é a
                * rota, que devolve 403 de qualquer jeito.
                */}
              {sound.canDelete ? (
                <button
                  type="button"
                  className={styles.remove}
                  onClick={() => onDelete(sound.id)}
                  title={`Apagar "${sound.label}" desta sala`}
                  aria-label={`Apagar ${sound.label}`}
                >
                  <TrashIcon />
                </button>
              ) : null}
              {/*
                * O card sempre dispara, inclusive sobre um som que já esteja
                * tocando — nesse caso o som recomeça do zero, para a sala
                * inteira, em vez de tocar em dobro. Parar é só o selo.
                */}
              <button
                type="button"
                className={`${styles.sound} ${sound.remote !== null ? styles.uploaded : ''}`}
                onClick={() => onPlay(sound.id)}
                title={
                  isPlaying
                    ? `Recomeçar "${sound.label}" do início`
                    : sound.uploadedBy !== null
                      ? `Tocar "${sound.label}" para a sala — enviado por ${sound.uploadedBy}`
                      : `Tocar "${sound.label}" para a sala`
                }
              >
                <span className={styles.emoji} aria-hidden="true">
                  {sound.emoji}
                </span>
                {sound.label}
              </button>
            </div>
          );
        })}
      </div>

      <div className={styles.volumeRow}>
        <button
          type="button"
          className={`${styles.mute} ${muted ? styles.muteOn : ''}`}
          onClick={onToggleMute}
          aria-pressed={muted}
          title={muted ? 'Voltar a ouvir os sons' : 'Silenciar os sons'}
        >
          <SpeakerIcon />
        </button>
        <input
          type="range"
          className={styles.slider}
          min={0}
          max={100}
          step={1}
          value={Math.round(volume * 100)}
          onChange={(event) => onVolumeChange(Number(event.target.value) / 100)}
          disabled={muted}
          aria-label="Volume dos sons"
        />
        <span className={styles.volumeValue}>{muted ? 'mudo' : `${Math.round(volume * 100)}%`}</span>
      </div>

      <p className={styles.hint}>
        {isUploading ? 'Enviando…' : 'O volume é só seu — cada pessoa ajusta o quanto ouve.'}
      </p>

      {/* Realce de "solte aqui". Fica por cima de tudo, sem capturar ponteiro:
          é o painel que trata o drop, e uma camada clicável no meio comeria o
          evento antes de ele chegar lá. */}
      {isDragging ? (
        <div className={styles.dropHint} aria-hidden="true">
          <UploadIcon />
          Solte para acrescentar à sala
        </div>
      ) : null}
    </div>
  );
}
