import {
  useCallback,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { readPanelWidth, writePanelWidth } from '../lib/storage';

export interface ResizeHandleProps {
  role: 'separator';
  tabIndex: 0;
  'aria-orientation': 'vertical';
  'aria-label': string;
  'aria-valuenow': number;
  'aria-valuemin': number;
  'aria-valuemax': number;
  title: string;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
}

export interface ResizablePanel {
  width: number;
  isResizing: boolean;
  handleProps: ResizeHandleProps;
}

export interface ResizablePanelOptions {
  /** Nome usado para guardar a largura entre visitas. */
  name: string;
  /** De que lado do container o painel encosta. */
  side: 'left' | 'right';
  label: string;
  min: number;
  max: number;
  initial: number;
}

/**
 * Divisória arrastável para um painel encostado numa borda do container.
 *
 * Usa pointer capture: uma vez capturado, o ponteiro continua entregando
 * eventos à alça mesmo quando o cursor sai dela — sem isso, arrastar rápido
 * "solta" a divisória no meio do caminho.
 *
 * A largura é derivada da posição absoluta do cursor dentro do container, e
 * não de um acumulado de deltas, então a alça nunca dessincroniza do cursor
 * ao bater nos limites. Por isso o lado importa: à esquerda a largura cresce
 * com o cursor, à direita ela cresce contra ele.
 */
export function useResizablePanel(
  containerRef: RefObject<HTMLElement | null>,
  options: ResizablePanelOptions,
): ResizablePanel {
  const { name, side, label, min, max, initial } = options;

  const clampWidth = useCallback(
    (value: number): number => Math.min(max, Math.max(min, Math.round(value))),
    [min, max],
  );

  const [width, setWidthState] = useState(() => clampWidth(readPanelWidth(name, initial)));
  const [isResizing, setIsResizing] = useState(false);

  const setWidth = useCallback(
    (next: number) => {
      const clamped = clampWidth(next);
      setWidthState(clamped);
      writePanelWidth(name, clamped);
    },
    [clampWidth, name],
  );

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsResizing(true);
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
        return;
      }
      const container = containerRef.current;
      if (container === null) {
        return;
      }
      const rect = container.getBoundingClientRect();
      setWidth(side === 'left' ? event.clientX - rect.left : rect.right - event.clientX);
    },
    [containerRef, side, setWidth],
  );

  const stopResizing = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsResizing(false);
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 32 : 8;
      // À direita, a seta que "abre" o painel é a oposta: seta para a esquerda
      // empurra a divisória e alarga o painel.
      const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
      const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';

      switch (event.key) {
        case grow:
          event.preventDefault();
          setWidth(width + step);
          break;
        case shrink:
          event.preventDefault();
          setWidth(width - step);
          break;
        case 'Home':
          event.preventDefault();
          setWidth(min);
          break;
        case 'End':
          event.preventDefault();
          setWidth(max);
          break;
        default:
          break;
      }
    },
    [side, width, setWidth, min, max],
  );

  const onDoubleClick = useCallback(() => setWidth(initial), [setWidth, initial]);

  return {
    width,
    isResizing,
    handleProps: {
      role: 'separator',
      tabIndex: 0,
      'aria-orientation': 'vertical',
      'aria-label': label,
      'aria-valuenow': width,
      'aria-valuemin': min,
      'aria-valuemax': max,
      title: 'Arraste para redimensionar · duplo clique para restaurar',
      onPointerDown,
      onPointerMove,
      onPointerUp: stopResizing,
      onPointerCancel: stopResizing,
      onKeyDown,
      onDoubleClick,
    },
  };
}
