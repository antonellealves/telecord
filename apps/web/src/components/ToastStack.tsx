import type { Toast } from '../hooks/useToasts';
import styles from './ToastStack.module.css';

interface ToastStackProps {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

export function ToastStack({ toasts, onDismiss }: ToastStackProps): JSX.Element | null {
  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className={styles.stack} role="log" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`${styles.toast} ${toast.kind === 'error' ? styles.error : ''}`}
        >
          <p className={styles.message}>{toast.message}</p>
          <button
            type="button"
            className={styles.close}
            onClick={() => onDismiss(toast.id)}
            aria-label="Fechar aviso"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
