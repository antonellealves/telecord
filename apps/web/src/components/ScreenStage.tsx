import { useCallback, useEffect, useRef, useState } from 'react';
import type { RemoteTrackPublication } from 'livekit-client';
import type { TilePosition } from '@telecord/shared';
import type { ScreenShareEntry } from '../hooks/useScreenShares';
import type { TileLayoutState } from '../hooks/useTileLayout';
import { useTileLayout } from '../hooks/useTileLayout';
import { useZoomPan } from '../hooks/useZoomPan';
import { readHideOwnScreen, writeHideOwnScreen } from '../lib/storage';
import { ExpandIcon, EyeIcon, EyeOffIcon, ShrinkIcon } from './icons';
import styles from './ScreenStage.module.css';

interface ScreenStageProps {
  entries: ScreenShareEntry[];
  roomId: string;
  /**
   * Identidade de quem está OLHANDO — a arrumação do palco é de quem
   * organiza, não de quem é organizado (ver `useTileLayout`). É a mesma
   * chave que o modo mediasoup usa (lá, `readPeerId()`; aqui, a identity
   * estável do LiveKit).
   */
  viewerIdentity: string;
}

/**
 * normal · tela cheia de verdade · maximizado dentro da página.
 *
 * "Maximizado" aqui é só o FALLBACK de tela cheia (iOS e afins não
 * implementam `requestFullscreen` em `<div>`) — não é mais o mesmo estado
 * que `useTileLayout.maximized` (arrastar/redimensionar, o mesmo mecanismo
 * do modo mediasoup). Os dois "maximizar" agora são coisas diferentes: um é tela
 * cheia de reserva, o outro é "ocupar o palco sem sair da página".
 */
type TileMode = 'normal' | 'fullscreen';

/**
 * Um quadro de tela compartilhada, com zoom e tela cheia.
 *
 * O elemento de vídeo é SEMPRE mudo. O áudio da tela chega pelo
 * RoomAudioRenderer, que só toca tracks remotas: se o vídeo também tocasse,
 * quem assiste ouviria dobrado e quem compartilha ouviria o próprio áudio
 * voltando.
 */
interface ScreenTileProps {
  entry: ScreenShareEntry;
  layout: TileLayoutState;
  peerKey: string;
  /** Só no quadro da própria tela: tira o quadro inteiro do palco. */
  onHideOwn?: () => void;
}

function ScreenTile({ entry, layout, peerKey, onHideOwn }: ScreenTileProps): JSX.Element {
  const tileRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [mode, setMode] = useState<TileMode>('normal');
  const zoom = useZoomPan();
  const track = entry.publication.track ?? null;

  const isMaximized = layout.maximized === peerKey;
  const position: TilePosition | undefined = layout.tiles[peerKey];
  const isDragging = layout.dragging === peerKey;

  /*
   * Parar de assistir DESASSINA a track, em vez de só esconder o vídeo.
   *
   * Esconder com CSS pararia de desenhar e continuaria baixando: o SFU seguiria
   * mandando a tela inteira, e quem parou de assistir justamente porque a
   * conexão não aguenta não ganharia nada. `setSubscribed(false)` corta o
   * envio na origem — é a única forma de o botão realmente aliviar a banda.
   *
   * Vale só para tela dos outros: publicação local não é assinatura, e o
   * `setSubscribed` nem existe nela.
   */
  const remote =
    !entry.owner.isLocal && 'setSubscribed' in entry.publication
      ? (entry.publication as RemoteTrackPublication)
      : null;
  const canUnsubscribe = remote !== null;
  const [isWatching, setIsWatching] = useState(true);

  const toggleWatching = useCallback(() => {
    if (remote === null) {
      return;
    }
    const next = !isWatching;
    remote.setSubscribed(next);
    setIsWatching(next);
  }, [remote, isWatching]);

  /*
   * Quem parou de assistir e saiu da sala não deve levar a escolha adiante: a
   * assinatura é reposta ao desmontar, senão a track ficaria desassinada para
   * a próxima vez que o mesmo quadro aparecesse.
   */
  useEffect(() => {
    return () => {
      remote?.setSubscribed(true);
    };
  }, [remote]);

  useEffect(() => {
    const element = videoRef.current;
    if (element === null || track === null) {
      return;
    }
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [track]);

  useEffect(() => {
    const handleChange = (): void => {
      setMode(document.fullscreenElement === tileRef.current ? 'fullscreen' : 'normal');
    };
    document.addEventListener('fullscreenchange', handleChange);
    return () => document.removeEventListener('fullscreenchange', handleChange);
  }, []);

  /**
   * Tenta a tela cheia de verdade e cai para o "maximizar" do layout
   * compartilhado quando ela não existe ou é recusada — iOS não implementa
   * requestFullscreen em div, e alguns contextos embutidos bloqueiam a API.
   * Antes, a recusa era engolida e o botão parecia morto.
   */
  const toggleExpand = useCallback(() => {
    const tile = tileRef.current;
    if (tile === null) {
      return;
    }
    if (mode === 'fullscreen') {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (isMaximized) {
      layout.toggleMaximized(peerKey);
      return;
    }
    if (typeof tile.requestFullscreen === 'function') {
      void tile.requestFullscreen().catch(() => layout.toggleMaximized(peerKey));
      return;
    }
    layout.toggleMaximized(peerKey);
  }, [mode, isMaximized, layout, peerKey]);

  const isExpanded = mode === 'fullscreen' || isMaximized;

  /*
   * Posição salva vira `position: absolute` em porcentagem — mesmo esquema
   * do modo mediasoup (`useTileLayout`). Sem posição, o quadro fica no fluxo da
   * grade automática; quem nunca arrastou nunca percebe a diferença.
   */
  const tileStyle =
    position === undefined
      ? undefined
      : {
          position: 'absolute' as const,
          left: `${position.x * 100}%`,
          top: `${position.y * 100}%`,
          width: `${position.w * 100}%`,
          height: `${position.h * 100}%`,
        };

  return (
    <div
      className={[
        styles.tile,
        mode === 'fullscreen' ? styles.tileFullscreen : '',
        isMaximized ? styles.tileMaximized : '',
        isDragging ? styles.tileDragging : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={isMaximized ? undefined : tileStyle}
      ref={tileRef}
      onPointerDown={(event) => {
        // Arrastar não pode roubar clique de botão nem o pan do zoom
        // (`useZoomPan` só arrasta quando `scale > 1`; abaixo disso o
        // ponteiro sobra livre para mover o quadro).
        if (zoom.scale > 1 || isMaximized) return;
        layout.beginDrag(peerKey, event);
      }}
    >
      <div
        className={styles.viewport}
        ref={zoom.viewportRef}
        onDoubleClick={toggleExpand}
        title="Role para ampliar · arraste o quadro para mover · duplo clique para tela cheia"
      >
        <div className={styles.surface} ref={zoom.contentRef}>
          <video ref={videoRef} className={styles.video} autoPlay playsInline muted />
        </div>

        {/*
          * Sem isto, parar de assistir deixaria um retângulo preto e mudo, que
          * é indistinguível de transmissão travada — o aviso diz que a
          * escolha foi sua e como desfazê-la.
          */}
        {!isWatching ? (
          <div className={styles.paused}>
            <EyeOffIcon className={styles.pausedIcon} />
            <p className={styles.pausedTitle}>Você parou de assistir</p>
            <p className={styles.pausedHint}>
              {entry.owner.displayName} continua compartilhando. Nada está sendo baixado.
            </p>
            <button type="button" className={styles.pausedButton} onClick={toggleWatching}>
              Voltar a assistir
            </button>
          </div>
        ) : null}
      </div>

      <span className={styles.label}>
        <span className={styles.live} aria-hidden="true" />
        {entry.owner.isLocal ? 'você' : entry.owner.displayName}
      </span>

      {/*
        * Só existe quando o quadro JÁ tem posição própria e não está
        * maximizado: no modo grade quem manda no tamanho é o CSS, e um punho
        * ali prometeria um arrasto que o layout desfaria no próximo quadro.
        */}
      {position !== undefined && !isMaximized ? (
        <span
          className={styles.resizeHandle}
          onPointerDown={(event) => {
            event.stopPropagation();
            layout.beginResize(peerKey, event);
          }}
          role="separator"
          aria-label="Redimensionar"
          title="Arraste para redimensionar"
        />
      ) : null}

      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.tool}
          onClick={zoom.zoomOut}
          disabled={!zoom.canZoomOut}
          title="Diminuir"
          aria-label="Diminuir"
        >
          −
        </button>
        <button
          type="button"
          className={`${styles.tool} ${styles.level}`}
          onClick={zoom.reset}
          disabled={!zoom.canZoomOut}
          title="Voltar ao tamanho da tela"
        >
          {Math.round(zoom.scale * 100)}%
        </button>
        <button
          type="button"
          className={styles.tool}
          onClick={zoom.zoomIn}
          disabled={!zoom.canZoomIn}
          title="Ampliar"
          aria-label="Ampliar"
        >
          +
        </button>

        <span className={styles.divider} aria-hidden="true" />

        <button
          type="button"
          className={styles.tool}
          onClick={toggleExpand}
          title={isExpanded ? 'Sair da tela cheia (Esc)' : 'Ver em tela cheia'}
          aria-label={isExpanded ? 'Sair da tela cheia' : 'Ver em tela cheia'}
        >
          {isExpanded ? <ShrinkIcon /> : <ExpandIcon />}
        </button>

        {onHideOwn !== undefined ? (
          <button
            type="button"
            className={styles.tool}
            onClick={onHideOwn}
            title="Ocultar sua tela do palco — os outros continuam vendo"
            aria-label="Ocultar sua tela"
          >
            <EyeOffIcon />
          </button>
        ) : null}

        {canUnsubscribe ? (
          <button
            type="button"
            className={styles.tool}
            onClick={toggleWatching}
            title={
              isWatching
                ? 'Parar de assistir — libera a banda desta tela'
                : 'Voltar a assistir esta tela'
            }
            aria-label={isWatching ? 'Parar de assistir' : 'Voltar a assistir'}
          >
            {isWatching ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Chave de layout: `identity` de quem compartilha, não `trackSid`. O
 * trackSid muda a cada nova publicação (parar e compartilhar de novo gera
 * um SID novo) — se fosse a chave, a posição arrumada se perderia a cada
 * novo compartilhamento da mesma pessoa.
 */
const peerKeyOf = (entry: ScreenShareEntry): string => entry.owner.identity;

/** Palco: uma grade com todas as telas compartilhadas, ou o estado vazio. */
export function ScreenStage({ entries, roomId, viewerIdentity }: ScreenStageProps): JSX.Element {
  /*
   * `fetchLayout`/`saveLayout` gravam o dicionário INTEIRO de tiles por
   * (sala, peerId) — se ScreenStage e CameraStrip usassem a mesma
   * `viewerIdentity` crua, cada `useTileLayout` reescreveria por cima do
   * dicionário do outro (last-write-wins), perdendo a arrumação de um dos
   * dois palcos. O sufixo separa os dois espaços de armazenamento.
   */
  const layout = useTileLayout(roomId, `${viewerIdentity}:screen`);
  const [ownHidden, setOwnHidden] = useState(readHideOwnScreen);

  const setHidden = useCallback((hidden: boolean) => {
    writeHideOwnScreen(hidden);
    setOwnHidden(hidden);
  }, []);

  const hasOwn = entries.some((entry) => entry.owner.isLocal);
  // Tirar o quadro da lista (e não só escondê-lo com CSS) desmonta o <video>:
  // a track é desanexada e o navegador para de decodificar e desenhar.
  const visible = ownHidden ? entries.filter((entry) => !entry.owner.isLocal) : entries;
  const showOwnButton = (
    <button type="button" className={styles.pausedButton} onClick={() => setHidden(false)}>
      Mostrar minha tela
    </button>
  );

  if (hasOwn && visible.length === 0) {
    return (
      <section className={styles.stage} aria-label="Telas compartilhadas">
        <div className={styles.empty}>
          <EyeOffIcon className={styles.pausedIcon} />
          <p className={styles.emptyTitle}>Você está compartilhando a tela</p>
          <p className={styles.emptyHint}>
            O quadro está oculto só para você — quem está na sala continua vendo normalmente.
          </p>
          {showOwnButton}
        </div>
      </section>
    );
  }

  if (entries.length === 0) {
    return (
      <section className={styles.stage} aria-label="Telas compartilhadas">
        <div className={styles.empty}>
          <div className={styles.frame} aria-hidden="true" />
          <p className={styles.emptyTitle}>Ninguém está compartilhando a tela</p>
          <p className={styles.emptyHint}>
            Use o botão “Compartilhar tela” na barra abaixo. Mais de uma pessoa pode
            compartilhar ao mesmo tempo.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section
      className={`${styles.stage} ${styles.grid}`}
      data-count={Math.min(visible.length, 4)}
      aria-label="Telas compartilhadas"
    >
      {visible.map((entry) => (
        <ScreenTile
          key={entry.owner.trackSid}
          entry={entry}
          layout={layout}
          peerKey={peerKeyOf(entry)}
          onHideOwn={entry.owner.isLocal ? () => setHidden(true) : undefined}
        />
      ))}
      {hasOwn && ownHidden ? (
        <div className={styles.ownHidden}>
          <EyeOffIcon className={styles.ownHiddenIcon} />
          <span>Sua tela está oculta para você</span>
          <button type="button" className={styles.ownHiddenButton} onClick={() => setHidden(false)}>
            Mostrar
          </button>
        </div>
      ) : null}
    </section>
  );
}
