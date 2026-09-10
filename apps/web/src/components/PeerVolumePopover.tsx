import { useEffect, useRef, type RefObject } from 'react';
import type { PeerVolumeState } from '../hooks/usePeerVolume';
import { PeerVolumeControl } from './PeerVolumeControl';
import styles from './PeerVolumePopover.module.css';

interface PeerVolumePopoverProps {
  identity: string;
  displayName: string;
  peerVolume: PeerVolumeState;
  /** Elemento que, clicado fora dele, fecha o popover — o nome que o abriu. */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}

/**
 * O "enhancement de áudio": clique no nome de alguém no chat, arraste até
 * 200%.
 *
 * Não é um controle À PARTE do da `ParticipantSidebar` — é a MESMA
 * `PeerVolumeControl`, a mesma entrada de `usePeerVolume`, só ancorada num
 * lugar diferente. Ajustar pelo chat ou pela lista lateral chega no mesmo
 * volume salvo; a pessoa escolhe a superfície que estiver com a mão mais
 * perto na hora.
 */
export function PeerVolumePopover({
  identity,
  displayName,
  peerVolume,
  anchorRef,
  onClose,
}: PeerVolumePopoverProps): JSX.Element {
  const popoverRef = useRef<HTMLDivElement>(null);
  const entry = peerVolume.get(identity);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    const handlePointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return;
      // Fora do popover E fora do que o abriu (o nome no chat) — clicar de
      // novo no próprio nome fecha pelo toggle do chamador, não por aqui.
      if (popoverRef.current?.contains(event.target) === true) return;
      if (anchorRef.current?.contains(event.target) === true) return;
      onClose();
    };
    document.addEventListener('keydown', handleKey);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [anchorRef, onClose]);

  return (
    <div ref={popoverRef} className={styles.popover} role="dialog" aria-label={`Volume de ${displayName}`}>
      <p className={styles.title}>{displayName}</p>
      <PeerVolumeControl
        volume={entry.volume}
        muted={entry.muted}
        onVolumeChange={(volume) => peerVolume.setVolume(identity, volume)}
        onToggleMuted={() => peerVolume.toggleMuted(identity)}
        displayName={displayName}
      />
      <p className={styles.hint}>
        Acima de 100% é reforço além do volume normal do microfone dela — só para você.
      </p>
    </div>
  );
}
