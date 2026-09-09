import { useCallback, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  DISPLAY_NAME_MAX_LENGTH,
  ROOM_ID_MAX_LENGTH,
  normalizeDisplayName,
  slugifyRoomId,
  validateDisplayName,
  validateRoomId,
} from '@telecord/shared';
import { ActiveRoomsList } from '../components/ActiveRoomsList';
import { AmbientGradient } from '../components/AmbientGradient';
import { useActiveRooms } from '../hooks/useActiveRooms';
import { useDisplayName } from '../hooks/useDisplayName';
import { useMicrophonePermission } from '../hooks/useMicrophonePermission';
import { generateRoomId } from '../lib/media';
import { readLastRoom, writeLastRoom } from '../lib/storage';
import styles from './JoinPage.module.css';

const NOTES = ['entra mutado', 'várias telas', 'sem gravação'];

export function JoinPage(): JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [storedName, storeName] = useDisplayName();

  const [name, setName] = useState(storedName);
  const [room, setRoom] = useState(() => searchParams.get('sala') ?? '');
  const [error, setError] = useState<string | null>(null);

  const activeRooms = useActiveRooms();
  const microphone = useMicrophonePermission();
  const [lastRoom] = useState(() => readLastRoom());

  const previewSlug = room.trim() === '' ? '' : slugifyRoomId(room);

  /** Caminho comum de entrada: valida o nome, guarda e navega. */
  const enterRoom = useCallback(
    (slug: string): void => {
      const displayName = normalizeDisplayName(name);
      const nameError = validateDisplayName(displayName);
      if (nameError !== null) {
        setError(nameError);
        return;
      }
      const roomError = validateRoomId(slug);
      if (roomError !== null) {
        setError(roomError);
        return;
      }
      storeName(displayName);
      writeLastRoom(slug);
      setError(null);
      navigate(`/sala/${slug}`);
    },
    [name, storeName, navigate],
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    enterRoom(room.trim() === '' ? generateRoomId() : slugifyRoomId(room));
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

            {lastRoom !== '' && lastRoom !== previewSlug ? (
              <button type="button" className={styles.recall} onClick={() => setRoom(lastRoom)}>
                voltar para <span className={styles.hintSlug}>{lastRoom}</span>
              </button>
            ) : null}

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

            <div className={styles.permission}>
              {microphone.status === 'granted' ? (
                <p className={styles.permissionOk}>
                  <span className={styles.dot} aria-hidden="true" />
                  Microfone já autorizado neste navegador.
                </p>
              ) : microphone.status === 'denied' ? (
                <p className={styles.permissionWarn}>
                  Microfone bloqueado. Libere no cadeado da barra de endereços — dá para entrar
                  assim mesmo, só não vai dar para falar.
                </p>
              ) : (
                <>
                  <p className={styles.permissionAsk}>
                    Autorize o microfone uma vez e o navegador não pergunta mais neste
                    dispositivo.
                  </p>
                  <button
                    type="button"
                    className={styles.permissionButton}
                    onClick={microphone.request}
                    disabled={microphone.isRequesting}
                  >
                    {microphone.isRequesting ? 'Aguardando…' : 'Autorizar microfone'}
                  </button>
                </>
              )}
              {microphone.error !== null ? (
                <p className={styles.permissionWarn}>{microphone.error}</p>
              ) : null}
            </div>

            <button type="submit" className={styles.submit}>
              Entrar na sala
            </button>
          </form>

          <ActiveRoomsList
            rooms={activeRooms.rooms}
            isLoading={activeRooms.isLoading}
            error={activeRooms.error}
            onEnter={enterRoom}
            onRefresh={activeRooms.refresh}
          />

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
