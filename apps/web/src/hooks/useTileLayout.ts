import { useCallback, useEffect, useRef, useState } from 'react';
import { TILE_MIN_SIZE, type TileLayout, type TilePosition } from '@telecord/shared';
import { fetchLayout, saveLayout } from '../lib/peers';

/** Espera antes de gravar: arrastar dispara dezenas de posições por segundo. */
const SAVE_DEBOUNCE_MS = 700;

export interface TileLayoutState {
  /** Posição salva de cada quadro; quem não está aqui usa o automático. */
  tiles: TileLayout;
  /** Começa a arrastar um quadro. */
  beginDrag: (peerId: string, event: React.PointerEvent<HTMLElement>) => void;
  /** Começa a redimensionar pelo canto. */
  beginResize: (peerId: string, event: React.PointerEvent<HTMLElement>) => void;
  /** Ocupa o palco inteiro, ou volta ao tamanho anterior. */
  toggleMaximized: (peerId: string) => void;
  /** Qual quadro está maximizado agora, se algum. */
  maximized: string | null;
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


  /**
   * Redimensiona pelo canto inferior direito.
   *
   * Só um canto, e não os oito de uma janela: o palco é livre e os quadros não
   * encostam em beirada nenhuma, então puxar pelo canto de baixo-direita
   * resolve qualquer tamanho — os outros sete seriam sete alvos de arrasto
   * competindo com o gesto de mover, que é o gesto principal aqui.
   */
  const beginResize = useCallback(
    (alvo: string, event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;

      const punho = event.currentTarget;
      const tile = punho.parentElement;
      const palco = tile?.parentElement;
      if (tile == null || palco == null) return;

      const areaPalco = palco.getBoundingClientRect();
      const areaTile = tile.getBoundingClientRect();
      const x = (areaTile.left - areaPalco.left) / areaPalco.width;
      const y = (areaTile.top - areaPalco.top) / areaPalco.height;

      // Não deixa o gesto virar arrasto do quadro inteiro.
      event.preventDefault();
      event.stopPropagation();
      punho.setPointerCapture(event.pointerId);
      setDragging(alvo);

      const mover = (e: PointerEvent): void => {
        const w = (e.clientX - areaTile.left) / areaPalco.width;
        const h = (e.clientY - areaTile.top) / areaPalco.height;
        setTiles((atual) => ({
          ...atual,
          [alvo]: {
            x,
            y,
            // Piso para o quadro não sumir, e teto para não passar do palco.
            w: Math.max(TILE_MIN_SIZE, Math.min(1 - x, w)),
            h: Math.max(TILE_MIN_SIZE, Math.min(1 - y, h)),
          },
        }));
      };

      const soltar = (): void => {
        punho.removeEventListener('pointermove', mover);
        punho.removeEventListener('pointerup', soltar);
        punho.removeEventListener('pointercancel', soltar);
        setDragging(null);
        agendarSalvar();
      };

      punho.addEventListener('pointermove', mover);
      punho.addEventListener('pointerup', soltar);
      punho.addEventListener('pointercancel', soltar);
    },
    [agendarSalvar],
  );

  /**
   * Maximiza um quadro, ou devolve ao tamanho que ele tinha.
   *
   * O tamanho anterior fica guardado em memória, não no banco: maximizar é
   * gesto de momento — "quero ver esta tela agora" —, e gravar isso faria a
   * pessoa voltar na próxima sessão com um quadro ocupando tudo sem lembrar
   * por quê. O que se grava é o tamanho de onde ela saiu.
   */
  const anteriorRef = useRef<{ id: string; posicao: TilePosition | undefined } | null>(null);
  const [maximized, setMaximized] = useState<string | null>(null);

  const toggleMaximized = useCallback(
    (alvo: string) => {
      if (maximized === alvo) {
        const anterior = anteriorRef.current;
        setTiles((atual) => {
          const proximo = { ...atual };
          if (anterior?.posicao === undefined) delete proximo[alvo];
          else proximo[alvo] = anterior.posicao;
          return proximo;
        });
        anteriorRef.current = null;
        setMaximized(null);
        agendarSalvar();
        return;
      }

      anteriorRef.current = { id: alvo, posicao: tilesRef.current[alvo] };
      setTiles((atual) => ({ ...atual, [alvo]: { x: 0, y: 0, w: 1, h: 1 } }));
      setMaximized(alvo);
    },
    [maximized, agendarSalvar],
  );

  /* Esc devolve o quadro maximizado, como em qualquer tela cheia. */
  useEffect(() => {
    if (maximized === null) return;
    const aoTeclar = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') toggleMaximized(maximized);
    };
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, [maximized, toggleMaximized]);

  const reset = useCallback(() => {
    setTiles({});
    window.clearTimeout(saveTimer.current);
    void saveLayout(roomSlug, peerId, {}).catch(() => undefined);
  }, [roomSlug, peerId]);

  return {
    tiles,
    beginDrag,
    beginResize,
    toggleMaximized,
    maximized,
    reset,
    isCustom: Object.keys(tiles).length > 0,
    dragging,
  };
}
