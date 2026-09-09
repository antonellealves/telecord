import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MAX_CHAT_LENGTH } from '@telecord/shared';
import type { ChatEntry } from '../hooks/useRoomMessages';
import styles from './ChatPanel.module.css';

interface ChatPanelProps {
  messages: ChatEntry[];
  onSend: (body: string) => void;
  onClose: () => void;
}

function timeOf(sentAt: number): string {
  return new Date(sentAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export function ChatPanel({ messages, onSend, onClose }: ChatPanelProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);

  // Só rola sozinho se a pessoa já estava no fim: puxar o histórico para ler
  // algo e ser arrastado de volta a cada mensagem nova é irritante.
  useEffect(() => {
    const list = listRef.current;
    if (list !== null && atBottomRef.current) {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages]);

  function handleScroll(): void {
    const list = listRef.current;
    if (list === null) {
      return;
    }
    atBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSend(draft);
    setDraft('');
    atBottomRef.current = true;
  }

  return (
    <aside className={styles.panel} aria-label="Chat da sala">
      <div className={styles.header}>
        <h2 className={styles.heading}>Chat</h2>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Fechar o chat">
          ×
        </button>
      </div>

      <div className={styles.list} ref={listRef} onScroll={handleScroll} role="log">
        {messages.length === 0 ? (
          <p className={styles.empty}>
            Nada por aqui ainda. As mensagens somem quando a sala acaba.
          </p>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`${styles.message} ${message.isLocal ? styles.mine : ''}`}
            >
              <div className={styles.meta}>
                <span className={styles.author}>{message.isLocal ? 'você' : message.author}</span>
                <span className={styles.time}>{timeOf(message.sentAt)}</span>
              </div>
              <p className={styles.body}>{message.body}</p>
            </div>
          ))
        )}
      </div>

      <form className={styles.composer} onSubmit={handleSubmit}>
        <input
          className={styles.input}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Escreva e aperte Enter"
          maxLength={MAX_CHAT_LENGTH}
          aria-label="Mensagem"
        />
        <button type="submit" className={styles.send} disabled={draft.trim() === ''}>
          Enviar
        </button>
      </form>
    </aside>
  );
}
