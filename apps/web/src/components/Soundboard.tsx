import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { SoundPlayback } from '../hooks/useRoomMessages';
import { SOUNDS } from '../lib/sounds';
import { InfoIcon, SpeakerIcon, StopIcon } from './icons';
import styles from './Soundboard.module.css';

/* Fixo porque só existe um painel de sons por vez na tela. */
const TIP_ID = 'soundboard-tip';

/*
 * Raio do card, copiado de `--radius-sm`. O `<rect>` do progresso precisa dele
 * como atributo, e atributo de SVG não lê variável de CSS. Mexeu num, mexa no
 * outro — senão o traço descola do canto arredondado.
 */
const TILE_RADIUS = 10;

type RingStyle = CSSProperties & { '--sound-duration': string };

interface SoundboardProps {
  /** Região que conta como "dentro" — inclui o botão que abre (ver DeviceSettings). */
  containerRef: RefObject<HTMLElement | null>;
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
 * Sons predefinidos, tocados para todo mundo na sala.
 *
 * O áudio não trafega: vai um aviso pelo canal de dados e cada cliente toca o
 * arquivo que já baixou junto com o app. Mandar o som como áudio custaria
 * banda por ouvinte e chegaria dessincronizado.
 *
 * Parar também é um aviso, não um gesto local: quem corta um clipe longo corta
 * para todos, que é o motivo de existir o botão. Silenciar só para si é o que
 * o controle de volume já faz.
 *
 * Clicar num card sempre dispara o som: em cima de um que já toca, ele
 * recomeça do início em todo mundo. Encerrar é só pelo selo de parar.
 *
 * Cada card leva um emoji (de `SOUNDS`) na linha de cima. Numa grade de trinta
 * nomes parecidos ele é o que o olho acha primeiro; e é justamente ali que o
 * selo de parar aparece, cobrindo o emoji em vez do nome.
 *
 * Enquanto toca, a própria borda do card se preenche no ritmo do clipe. Quem
 * ouve um som longo quer saber se falta muito antes de decidir cortar — e o
 * traço na borda cabe onde não havia espaço para uma barra.
 */
export function Soundboard({
  containerRef,
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
  /* Onde ficam o "i" e a dica: clique fora daqui fecha a dica. */
  const tipRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className={styles.panel} role="dialog" aria-label="Sons">
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
              Para acrescentar um som, largue o arquivo em{' '}
              <code className={styles.code}>apps/web/src/assets/sons</code> — o nome do arquivo
              vira o rótulo, sem precisar mexer no código.
            </span>
          </div>
        </div>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Fechar">
          ×
        </button>
      </div>

      <div className={styles.grid}>
        {SOUNDS.length === 0 ? (
          <p className={styles.empty}>
            Nenhum som instalado. Largue arquivos de áudio em{' '}
            <code className={styles.code}>apps/web/src/assets/sons</code>.
          </p>
        ) : null}
        {SOUNDS.map((sound) => {
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
                * O card sempre dispara, inclusive sobre um som que já esteja
                * tocando — nesse caso o som recomeça do zero, para a sala
                * inteira, em vez de tocar em dobro. Parar é só o selo.
                */}
              <button
                type="button"
                className={styles.sound}
                onClick={() => onPlay(sound.id)}
                title={
                  isPlaying
                    ? `Recomeçar "${sound.label}" do início`
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

      <p className={styles.hint}>O volume é só seu — cada pessoa ajusta o quanto ouve.</p>
    </div>
  );
}
