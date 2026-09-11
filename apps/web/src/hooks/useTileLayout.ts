import { useCallback, useEffect, useRef, useState } from 'react';
import type { TileLayout, TilePosition } from '@telecord/shared';
import { fetchLayout, saveLayout } from '../lib/peers';

/** Espera antes de gravar: arrastar dispara dezenas de posições por segundo. */
const SAVE_DEBOUNCE_MS = 700;

export interface TileLayoutState {
  /** Posição salva de cada quadro; quem não está aqui usa o automático. */
  tiles: TileLayout;
  /** Começa a arrastar um quadro. */
  beginDrag: (peerId: string, event: React.PointerEvent<HTMLElement>) => void;
  /** Devolve tudo ao automático. */
  reset: () => void;
  /** Algum quadro foi movido: liga o botão de desfazer. */
  isCustom: boolean;
  /** Quem está sendo arrastado agora, para a tela levantá-lo. */
  dragging: string | null;
}

/**
 * Arrastar e guardar a posição dos quadros.
 *
 * ## A posição é de quem OLHA
 *
 * Arrastar o quadro de alguém muda a SUA tela, não a dela nem a dos outros.
 * É o oposto de "mover pessoa de sala", que é ato de moderação — aqui é
 * arrumar a própria mesa. Por isso a chave no banco é (sala, quem arrumou), e
 * não (sala, quem é olhado).
 *
 * ## Por que fração e não pixel
 *
 * Guardado em 0..1 da área do palco. Quem arruma no monitor grande e volta no
 * notebook encontra a mesma arrumação proporcional, em vez de quadros fora da
 * tela — que seria o resultado de guardar pixel.
 */
export function useTileLayout(roomSlug: string, peerId: string): TileLayoutState {
  const [tiles, setTiles] = useState<TileLayout>({});
  const [dragging, setDragging] = useState<string | null>(null);

  const tilesRef = useRef<TileLayout>(tiles);
  tilesRef.current = tiles;
  const saveTimer = useRef(0);

  // Carrega uma vez por sala. Falhar aqui não é erro visível: sem arrumação
  // salva, o palco cai no automático, que é o estado normal.
  useEffect(() => {
    let vivo = true;
    void fetchLayout(roomSlug, peerId)
      .then((salvo) => {
        if (vivo) setTiles(salvo);
      })
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, [roomSlug, peerId]);

  const agendarSalvar = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void saveLayout(roomSlug, peerId, tilesRef.current).catch(() => undefined);
    }, SAVE_DEBOUNCE_MS);
  }, [roomSlug, peerId]);

  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  const beginDrag = useCallback(
    (alvo: string, event: React.PointerEvent<HTMLElement>) => {
      // Só botão principal, e nunca em cima de um controle: arrastar não pode
      // roubar o clique de um botão dentro do quadro.
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest('button,select,input,a') !== null) return;

      const tile = event.currentTarget;
      const palco = tile.parentElement;
      if (palco === null) return;

      const areaPalco = palco.getBoundingClientRect();
      const areaTile = tile.getBoundingClientRect();
      // Distância do ponteiro até o canto do quadro: sem isto, o quadro salta
      // para debaixo do cursor no primeiro movimento.
      const offsetX = event.clientX - areaTile.left;
      const offsetY = event.clientY - areaTile.top;

      const w = areaTile.width / areaPalco.width;
      const h = areaTile.height / areaPalco.height;

      event.preventDefault();
      tile.setPointerCapture(event.pointerId);
      setDragging(alvo);

      const mover = (e: PointerEvent): void => {
        const x = (e.clientX - offsetX - areaPalco.left) / areaPalco.width;
        const y = (e.clientY - offsetY - areaPalco.top) / areaPalco.height;
        const posicao: TilePosition = {
          // Prende dentro do palco: quadro arrastado para fora não volta.
          x: Math.max(0, Math.min(1 - w, x)),
          y: Math.max(0, Math.min(1 - h, y)),
          w,
          h,
        };
        setTiles((atual) => ({ ...atual, [alvo]: posicao }));
      };

      const soltar = (): void => {
        tile.removeEventListener('pointermove', mover);
        tile.removeEventListener('pointerup', soltar);
        tile.removeEventListener('pointercancel', soltar);
        setDragging(null);
        agendarSalvar();
      };

      tile.addEventListener('pointermove', mover);
      tile.addEventListener('pointerup', soltar);
      tile.addEventListener('pointercancel', soltar);
    },
    [agendarSalvar],
  );

  const reset = useCallback(() => {
    setTiles({});
    window.clearTimeout(saveTimer.current);
    void saveLayout(roomSlug, peerId, {}).catch(() => undefined);
  }, [roomSlug, peerId]);

  return { tiles, beginDrag, reset, isCustom: Object.keys(tiles).length > 0, dragging };
}
