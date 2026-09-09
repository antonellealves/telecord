import {
  useCallback,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

export const SIDEBAR_MIN_WIDTH = 208;
export const SIDEBAR_MAX_WIDTH = 440;
export const SIDEBAR_DEFAULT_WIDTH = 268;

function clampWidth(value: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
}

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

export interface ResizableSidebar {
  width: number;
  isResizing: boolean;
  handleProps: ResizeHandleProps;
}

/**
 * Divisória arrastável entre a lista de participantes e o palco.
 *
 * Usa pointer capture: uma vez capturado, o ponteiro continua entregando
 * eventos à alça mesmo quando o cursor sai dela — sem isso, arrastar rápido
 * "solta" a divisória no meio do caminho.
 *
 * A largura é derivada da posição absoluta do cursor dentro do container, e
 * não de um acumulado de deltas, então a alça nunca dessincroniza do cursor
 * ao bater nos limites.
 */
export function useResizableSidebar(containerRef: RefObject<HTMLElement | null>): ResizableSidebar {
  const [width, setWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);

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
      setWidth(clampWidth(event.clientX - container.getBoundingClientRect().left));
    },
    [containerRef],
  );

  const stopResizing = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsResizing(false);
  }, []);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 8;
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        setWidth((current) => clampWidth(current - step));
        break;
      case 'ArrowRight':
        event.preventDefault();
        setWidth((current) => clampWidth(current + step));
        break;
      case 'Home':
        event.preventDefault();
        setWidth(SIDEBAR_MIN_WIDTH);
        break;
      case 'End':
        event.preventDefault();
        setWidth(SIDEBAR_MAX_WIDTH);
        break;
      default:
        break;
    }
  }, []);

  const onDoubleClick = useCallback(() => setWidth(SIDEBAR_DEFAULT_WIDTH), []);

  return {
    width,
    isResizing,
    handleProps: {
      role: 'separator',
      tabIndex: 0,
      'aria-orientation': 'vertical',
      'aria-label': 'Redimensionar a lista de participantes',
      'aria-valuenow': width,
      'aria-valuemin': SIDEBAR_MIN_WIDTH,
      'aria-valuemax': SIDEBAR_MAX_WIDTH,
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
