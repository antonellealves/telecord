import type { ReactNode } from 'react';
import styles from './StatusScreen.module.css';

interface StatusScreenProps {
  title: string;
  message?: string;
  variant?: 'info' | 'error';
  loading?: boolean;
  children?: ReactNode;
}

/** Tela cheia para os estados em que ainda não há sala: token, erro, saída. */
export function StatusScreen({
  title,
  message,
  variant = 'info',
  loading = false,
  children,
}: StatusScreenProps): JSX.Element {
  return (
    <div className={styles.wrapper}>
      <div className={`${styles.card} ${variant === 'error' ? styles.error : ''}`} role="status">
        {loading ? <div className={styles.spinner} aria-hidden="true" /> : null}
        <h1 className={styles.title}>{title}</h1>
        {message !== undefined ? <p className={styles.message}>{message}</p> : null}
        {children !== undefined ? <div className={styles.actions}>{children}</div> : null}
      </div>
    </div>
  );
}
