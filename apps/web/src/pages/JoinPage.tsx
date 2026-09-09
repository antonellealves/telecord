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
import { AmbientGradient } from '../components/AmbientGradient';
import { useDisplayName } from '../hooks/useDisplayName';
import { generateRoomId } from '../lib/media';
import styles from './JoinPage.module.css';

const NOTES = ['entra mutado', 'uma tela por vez', 'sem gravação'];

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
    <>
      <AmbientGradient />

      <div className={styles.page}>
        <div className={styles.shell}>
          <header className={styles.hero}>
            <h1 className={styles.wordmark}>Telecord</h1>
            <p className={styles.tagline}>criar sala</p>
            <p className={styles.title}>
              Entre, fale e
              <span className={styles.titleAccent}>mostre a tela.</span>
            </p>
            <p className={styles.lead}>
              Supra sumo do entretenimento de dota 2 — entre, fale e mostre a tela.
            </p>
          </header>

          <form className={styles.card} onSubmit={handleSubmit}>
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
                {previewSlug === '' ? (
                  'Em branco cria uma sala nova com nome aleatório.'
                ) : (
                  <>
                    Você entra em <span className={styles.hintSlug}>/sala/{previewSlug}</span>
                  </>
                )}
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
              Entrar na sala
            </button>
          </form>

          <ul className={styles.notes}>
            {NOTES.map((note) => (
              <li key={note} className={styles.note}>
                <span className={styles.dot} aria-hidden="true" />
                {note}
              </li>
            ))}
          </ul>

          <p className={styles.signature}>feito com carinho para a galera do dota teleton</p>
        </div>
      </div>
    </>
  );
}
