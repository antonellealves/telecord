import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  DISPLAY_NAME_MAX_LENGTH,
  ROOM_ID_MAX_LENGTH,
  normalizeDisplayName,
  slugifyRoomId,
  validateDisplayName,
  validateRoomId,
} from '@telecord/shared';
import { useDisplayName } from '../hooks/useDisplayName';
import { generateRoomId } from '../lib/media';
import styles from './JoinPage.module.css';

export function JoinPage(): JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [storedName, storeName] = useDisplayName();

  const [name, setName] = useState(storedName);
  const [room, setRoom] = useState(() => searchParams.get('sala') ?? '');
  const [error, setError] = useState<string | null>(null);

  const previewSlug = room.trim() === '' ? '' : slugifyRoomId(room);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const displayName = normalizeDisplayName(name);
    const nameError = validateDisplayName(displayName);
    if (nameError !== null) {
      setError(nameError);
      return;
    }

    const slug = room.trim() === '' ? generateRoomId() : slugifyRoomId(room);
    const roomError = validateRoomId(slug);
    if (roomError !== null) {
      setError(roomError);
      return;
    }

    storeName(displayName);
    setError(null);
    navigate(`/sala/${slug}`);
  }

  return (
    <div className={styles.wrapper}>
      <form className={styles.card} onSubmit={handleSubmit}>
        <h1 className={styles.title}>Telecord</h1>
        <p className={styles.subtitle}>
          Sala de voz com compartilhamento de tela. Sem cadastro, sem gravação.
        </p>

        {error !== null ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}

        <label className={styles.field}>
          <span className={styles.label}>Nome da sala</span>
          <input
            className={styles.input}
            value={room}
            onChange={(event) => setRoom(event.target.value)}
            placeholder="reuniao-do-time"
            maxLength={ROOM_ID_MAX_LENGTH}
            autoComplete="off"
            spellCheck={false}
          />
          <p className={styles.hint}>
            {previewSlug === ''
              ? 'Deixe em branco para criar uma sala nova com nome aleatório.'
              : `Você vai entrar em /sala/${previewSlug}`}
          </p>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Seu nome</span>
          <input
            className={styles.input}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Como as pessoas vão te ver"
            maxLength={DISPLAY_NAME_MAX_LENGTH}
            autoComplete="nickname"
          />
          <p className={styles.hint}>Fica salvo neste navegador para a próxima vez.</p>
        </label>

        <button type="submit" className={styles.submit}>
          Entrar
        </button>

        <p className={styles.footnote}>
          Você entra com o microfone mutado. Uma pessoa compartilha a tela por vez, e a sala deixa
          de existir quando todo mundo sai.
        </p>
      </form>
    </div>
  );
}
