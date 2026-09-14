import { useEffect, useRef } from 'react';
import type { TilePosition } from '@telecord/shared';
import type { CameraEntry } from '../hooks/useCameras';
import { useTileLayout, type TileLayoutState } from '../hooks/useTileLayout';
import styles from './CameraStrip.module.css';

interface CameraStripProps {
  entries: CameraEntry[];
  /** Sem tela compartilhada, as câmeras ficam com o palco inteiro. */
  expanded: boolean;
  roomId: string;
  /** Ver o mesmo campo em `ScreenStageProps` — quem organiza, não quem é organizado. */
  viewerIdentity: string;
}

interface CameraTileProps {
  entry: CameraEntry;
  layout: TileLayoutState;
}

/**
 * Um quadro de câmera.
 *
 * `object-fit: cover` em vez de `contain`: rosto em quadro pequeno com tarja
 * preta em cima e embaixo desperdiça justamente o espaço que já é pouco.
 * O próprio vídeo é espelhado — é o que a pessoa espera ver de si mesma; os
 * dos outros, não, senão texto e lateralidade aparecem invertidos.
 */
function CameraTile({ entry, layout }: CameraTileProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const track = entry.publication.track ?? null;

  const position: TilePosition | undefined = layout.tiles[entry.identity];
  const isDragging = layout.dragging === entry.identity;

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
        entry.isSpeaking ? styles.speaking : '',
        isDragging ? styles.tileDragging : '',
        position !== undefined ? styles.tileCustom : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={tileStyle}
      onPointerDown={(event) => layout.beginDrag(entry.identity, event)}
      title="Arraste para mover este quadro"
    >
      <video
        ref={videoRef}
        className={`${styles.video} ${entry.isLocal ? styles.mirrored : ''}`}
        autoPlay
        playsInline
        muted
      />
      <span className={styles.name}>{entry.isLocal ? 'você' : entry.displayName}</span>

      {/* Só existe quando o quadro já tem posição própria — ver o mesmo
          comentário em ScreenStage.tsx. */}
      {position !== undefined ? (
        <span
          className={styles.resizeHandle}
          onPointerDown={(event) => {
            event.stopPropagation();
            layout.beginResize(entry.identity, event);
          }}
          role="separator"
          aria-label="Redimensionar"
          title="Arraste para redimensionar"
        />
      ) : null}
    </div>
  );
}

/** Faixa de câmeras, acima das telas compartilhadas. */
export function CameraStrip({ entries, expanded, roomId, viewerIdentity }: CameraStripProps): JSX.Element | null {
  // Mesmo motivo do sufixo em ScreenStage.tsx: espaço de armazenamento
  // próprio, para não sobrescrever o layout do outro palco.
  const layout = useTileLayout(roomId, `${viewerIdentity}:camera`);

  if (entries.length === 0) {
    return null;
  }

  return (
    <div
      className={`${styles.strip} ${expanded ? styles.expanded : ''}`}
      aria-label="Câmeras"
    >
      {entries.map((entry) => (
        <CameraTile key={entry.trackSid} entry={entry} layout={layout} />
      ))}
    </div>
  );
}
