import { useCallback, useEffect, useRef, useState } from 'react';

export type ToastKind = 'info' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface ToastApi {
  toasts: Toast[];
  push: (kind: ToastKind, message: string) => void;
  dismiss: (id: number) => void;
}

const TOAST_TTL_MS = 7000;

export function useToasts(): ToastApi {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const handle = timers.current.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      nextId.current += 1;
      const id = nextId.current;
      setToasts((current) => [...current, { id, kind, message }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), TOAST_TTL_MS),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const handle of pending.values()) {
        clearTimeout(handle);
      }
      pending.clear();
    };
  }, []);

  return { toasts, push, dismiss };
}
