import { useCallback, useEffect, useRef, useState } from 'react';

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const STEP = 1.35;

export interface ZoomPan {
  viewportRef: React.MutableRefObject<HTMLDivElement | null>;
  contentRef: React.MutableRefObject<HTMLDivElement | null>;
  scale: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
}

/**
 * Zoom e arrasto sobre a tela compartilhada.
 *
 * A escala e o deslocamento vivem em refs, não em estado: o arrasto atualiza a
 * cada movimento do ponteiro, e re-renderizar o quadro nesse ritmo desperdiça
 * trabalho à toa. O estado guarda só a escala, para o rótulo de porcentagem —
 * que muda no zoom, não no arrasto.
 *
 * O deslocamento é sempre travado dentro do conteúdo: sem isso dá para
 * arrastar a imagem para fora e ficar olhando para o vazio, sem entender como
 * voltar.
 */
export function useZoomPan(): ZoomPan {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const scaleRef = useRef(1);
  const xRef = useRef(0);
  const yRef = useRef(0);
  const [scale, setScale] = useState(1);

  const apply = useCallback(() => {
    const content = contentRef.current;
    if (content === null) return;
    content.style.transform = `translate(${xRef.current.toFixed(1)}px, ${yRef.current.toFixed(1)}px) scale(${scaleRef.current.toFixed(3)})`;
    content.style.cursor = scaleRef.current > 1 ? 'grab' : 'default';
  }, []);

  /** Trava o deslocamento para o conteúdo nunca descolar das bordas. */
  const clamp = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const { width, height } = viewport.getBoundingClientRect();
    const limitX = ((scaleRef.current - 1) * width) / 2;
    const limitY = ((scaleRef.current - 1) * height) / 2;
    xRef.current = Math.max(-limitX, Math.min(limitX, xRef.current));
    yRef.current = Math.max(-limitY, Math.min(limitY, yRef.current));
  }, []);

  /**
   * Amplia mantendo fixo o ponto sob o cursor. Sem isso, o zoom sempre puxa
   * para o centro e a pessoa persegue o que queria ver.
   */
  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const viewport = viewportRef.current;
      if (viewport === null) return;

      const rect = viewport.getBoundingClientRect();
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scaleRef.current * factor));
      if (next === scaleRef.current) return;

      const pointerX = (clientX ?? rect.left + rect.width / 2) - (rect.left + rect.width / 2);
      const pointerY = (clientY ?? rect.top + rect.height / 2) - (rect.top + rect.height / 2);

      xRef.current = pointerX - ((pointerX - xRef.current) * next) / scaleRef.current;
      yRef.current = pointerY - ((pointerY - yRef.current) * next) / scaleRef.current;
      scaleRef.current = next;

      if (next === MIN_SCALE) {
        xRef.current = 0;
        yRef.current = 0;
      }

      clamp();
      apply();
      setScale(next);
    },
    [apply, clamp],
  );

  const reset = useCallback(() => {
    scaleRef.current = 1;
    xRef.current = 0;
    yRef.current = 0;
    apply();
    setScale(1);
  }, [apply]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;

    // Listener nativo e não-passivo: a roda precisa de preventDefault para não
    // rolar a página junto, e o React registra `onWheel` como passivo.
    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault();
      zoomAt(event.deltaY < 0 ? STEP : 1 / STEP, event.clientX, event.clientY);
    };

    let panning = false;
    let lastX = 0;
    let lastY = 0;

    const handlePointerDown = (event: PointerEvent): void => {
      if (scaleRef.current <= 1 || event.button !== 0) return;
      panning = true;
      lastX = event.clientX;
      lastY = event.clientY;
      viewport.setPointerCapture(event.pointerId);
      const content = contentRef.current;
      if (content !== null) content.style.cursor = 'grabbing';
    };

    const handlePointerMove = (event: PointerEvent): void => {
      if (!panning) return;
      xRef.current += event.clientX - lastX;
      yRef.current += event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      clamp();
      apply();
    };

    const handlePointerUp = (event: PointerEvent): void => {
      if (!panning) return;
      panning = false;
      if (viewport.hasPointerCapture(event.pointerId)) {
        viewport.releasePointerCapture(event.pointerId);
      }
      apply();
    };

    viewport.addEventListener('wheel', handleWheel, { passive: false });
    viewport.addEventListener('pointerdown', handlePointerDown);
    viewport.addEventListener('pointermove', handlePointerMove);
    viewport.addEventListener('pointerup', handlePointerUp);
    viewport.addEventListener('pointercancel', handlePointerUp);

    return () => {
      viewport.removeEventListener('wheel', handleWheel);
      viewport.removeEventListener('pointerdown', handlePointerDown);
      viewport.removeEventListener('pointermove', handlePointerMove);
      viewport.removeEventListener('pointerup', handlePointerUp);
      viewport.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [zoomAt, clamp, apply]);

  // Redimensionar a janela muda os limites; sem reclampar, o conteúdo pode
  // ficar preso fora da área visível.
  useEffect(() => {
    const onResize = (): void => {
      clamp();
      apply();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clamp, apply]);

  return {
    viewportRef,
    contentRef,
    scale,
    canZoomIn: scale < MAX_SCALE,
    canZoomOut: scale > MIN_SCALE,
    zoomIn: () => zoomAt(STEP),
    zoomOut: () => zoomAt(1 / STEP),
    reset,
  };
}
