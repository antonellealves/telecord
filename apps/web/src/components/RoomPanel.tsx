import { useCallback, useEffect, useState, type FormEvent, type RefObject } from 'react';
import {
  ROOM_DESCRIPTION_MAX_LENGTH,
  ROOM_NAME_MAX_LENGTH,
  validateRoomDescription,
  validateRoomName,
  type RoomDetail,
  type RoomMemberRole,
  type RoomVisibility,
} from '@telecord/shared';
import { useAuth } from '../hooks/useAuth';
import { ApiError } from '../lib/apiClient';
import { createRoom, fetchRoom, removeMember, setMemberRole, updateRoom } from '../lib/rooms';
import styles from './RoomPanel.module.css';

const ROLE_LABEL: Record<RoomMemberRole, string> = {
  OWNER: 'dono',
  MOD: 'moderação',
  MEMBER: 'membro',
};

interface RoomPanelProps {
  roomId: string;
  /**
   * Região que conta como "dentro", e que INCLUI o botão que abre o painel.
   *
   * Sem incluí-lo, o clique no botão fecharia (por ser fora do painel) e
   * reabriria (pelo próprio clique) no mesmo gesto, e o painel nunca fecharia
   * pelo botão. É o mesmo arranjo do soundboard.
   */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}

/**
 * A ficha da sala: nome, descrição, dono e membros.
 *
 * ## Por que uma sala pode não existir aqui
 *
 * A sala do LiveKit nasce quando alguém entra; a linha no banco, só quando
 * alguém a batiza ou larga um som nela. As duas coisas continuam
 * independentes de propósito — entrar nunca dependeu deste serviço, e não
 * passa a depender. Quando não há linha, o painel oferece dar nome; e é isso
 * que faz de quem nomeia o dono.
 *
 * ## O que os papéis governam
 *
 * Renomear, mexer nos membros, apagar som dos outros. NÃO governam entrar:
 * qualquer pessoa com o endereço entra em qualquer sala, como sempre foi. Uma
 * sala "privada" que a função de token não consegue verificar seria um cadeado
 * desenhado na porta.
 */
export function RoomPanel({ roomId, anchorRef, onClose }: RoomPanelProps): JSX.Element {
  const { status, user } = useAuth();
  const isSignedIn = status === 'autenticado' && user !== null;

  const [room, setRoom] = useState<RoomDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [emoji, setEmoji] = useState('');
  const [visibility, setVisibility] = useState<RoomVisibility>('PUBLIC');

  const adopt = (detail: RoomDetail): void => {
    setRoom(detail);
    setMissing(false);
    setName(detail.name);
    setDescription(detail.description ?? '');
    setEmoji(detail.emoji ?? '');
    setVisibility(detail.visibility);
  };

  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);

    void fetchRoom(roomId, controller.signal)
      .then((detail) => {
        if (controller.signal.aborted) return;
        adopt(detail);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 404) {
          // Estado normal, não erro: a maioria das salas é avulsa.
          setMissing(true);
          setName(roomId);
          return;
        }
        setFailure(
          error instanceof ApiError ? error.message : 'Não deu para carregar a ficha da sala.',
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [roomId]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    const handlePointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return;
      const anchor = anchorRef.current;
      if (anchor !== null && !anchor.contains(event.target)) onClose();
    };
    document.addEventListener('keydown', handleKey);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [anchorRef, onClose]);

  const run = useCallback(async (action: () => Promise<RoomDetail | void>): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const detail = await action();
      if (detail !== undefined) adopt(detail);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Não deu para salvar.');
    } finally {
      setBusy(false);
    }
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const nameError = validateRoomName(name);
    const descriptionError = validateRoomDescription(description);
    if (nameError !== null || descriptionError !== null) {
      setFailure(nameError ?? descriptionError);
      return;
    }

    const payload = { name, description, emoji, visibility };
    // Sala sem linha e sala sem dono passam pelo mesmo caminho: `POST /rooms`
    // cria a primeira e adota a segunda. A rota recusa adotar sala que já tem
    // dono, então não há como este botão tomar a sala de alguém.
    void run(() =>
      missing || room?.myRole === null
        ? createRoom({ slug: roomId, ...payload })
        : updateRoom(roomId, payload),
    );
  };

  const canManage = room !== null && (room.myRole === 'OWNER' || room.myRole === 'MOD');
  const isOwner = room !== null && room.myRole === 'OWNER';
  const ownerless = room !== null && !room.members.some((member) => member.role === 'OWNER');

  return (
    <div className={styles.panel} role="dialog" aria-label="Ficha da sala">
      <div className={styles.header}>
        <h2 className={styles.heading}>Sala</h2>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Fechar">
          ×
        </button>
      </div>

      {failure !== null ? <p className={styles.error}>{failure}</p> : null}

      {isLoading ? (
        <p className={styles.muted}>Carregando…</p>
      ) : !isSignedIn ? (
        <>
          {room !== null ? <RoomSummaryView room={room} /> : null}
          <p className={styles.muted}>
            {room === null
              ? 'Esta sala ainda não tem nome. Entre com uma conta para batizá-la e para enviar sons próprios.'
              : 'Entre com uma conta para participar da sala e enviar sons.'}
          </p>
        </>
      ) : (
        <>
          {room !== null && !canManage ? <RoomSummaryView room={room} /> : null}

          {missing || ownerless || canManage ? (
            <form className={styles.form} onSubmit={submit}>
              {missing ? (
                <p className={styles.muted}>
                  Ninguém batizou esta sala ainda. Quem der o nome fica como dono.
                </p>
              ) : ownerless && !isOwner ? (
                <p className={styles.muted}>
                  Esta sala existe porque alguém deixou um som aqui, mas está sem dono. Você pode
                  assumi-la.
                </p>
              ) : null}

              <label className={styles.field}>
                <span className={styles.label}>Nome</span>
                <input
                  className={styles.input}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={ROOM_NAME_MAX_LENGTH}
                  placeholder="Dota da madrugada"
                />
              </label>

              <div className={styles.pair}>
                <label className={styles.field}>
                  <span className={styles.label}>Emoji</span>
                  <input
                    className={`${styles.input} ${styles.emojiInput}`}
                    value={emoji}
                    onChange={(event) => setEmoji(event.target.value)}
                    maxLength={8}
                    placeholder="🎮"
                    aria-label="Emoji da sala"
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>No diretório</span>
                  <select
                    className={styles.input}
                    value={visibility}
                    onChange={(event) => setVisibility(event.target.value as RoomVisibility)}
                  >
                    <option value="PUBLIC">aparece na lista</option>
                    <option value="UNLISTED">só por link</option>
                  </select>
                </label>
              </div>

              <label className={styles.field}>
                <span className={styles.label}>Descrição</span>
                <input
                  className={styles.input}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  maxLength={ROOM_DESCRIPTION_MAX_LENGTH}
                  placeholder="Do que é essa sala"
                />
              </label>

              {/*
                * "Só por link" tira do diretório e nada além disso. É a verdade
                * inteira, e escrevê-la aqui evita que alguém trate a opção como
                * uma tranca.
                */}
              <p className={styles.fine}>
                Fora do diretório a sala continua alcançável por quem tiver o endereço — entrar
                nunca depende desta ficha.
              </p>

              <button type="submit" className={styles.submit} disabled={busy}>
                {busy ? 'Salvando…' : missing ? 'Dar nome à sala' : ownerless && !isOwner ? 'Assumir a sala' : 'Salvar'}
              </button>
            </form>
          ) : null}

          {room !== null && room.members.length > 0 ? (
            <div className={styles.members}>
              <h3 className={styles.subheading}>Quem participa</h3>
              <ul className={styles.memberList}>
                {room.members.map((member) => (
                  <li key={member.userId} className={styles.member}>
                    <span className={styles.memberName}>{member.displayName}</span>
                    {isOwner && member.role !== 'OWNER' ? (
                      <span className={styles.memberActions}>
                        <select
                          className={styles.miniSelect}
                          value={member.role}
                          disabled={busy}
                          onChange={(event) =>
                            void run(() =>
                              setMemberRole(
                                roomId,
                                member.userId,
                                event.target.value as RoomMemberRole,
                              ),
                            )
                          }
                          aria-label={`Papel de ${member.displayName}`}
                        >
                          <option value="MEMBER">membro</option>
                          <option value="MOD">moderação</option>
                          <option value="OWNER">passar a posse</option>
                        </select>
                        <button
                          type="button"
                          className={styles.remove}
                          disabled={busy}
                          onClick={() => void run(() => removeMember(roomId, member.userId))}
                          title={`Tirar ${member.displayName} da sala`}
                        >
                          ×
                        </button>
                      </span>
                    ) : (
                      <span className={styles.role}>{ROLE_LABEL[member.role]}</span>
                    )}
                  </li>
                ))}
              </ul>

              {room.myRole !== null && room.myRole !== 'OWNER' ? (
                <button
                  type="button"
                  className={styles.leave}
                  disabled={busy}
                  onClick={() => void run(() => removeMember(roomId, user.id))}
                >
                  sair desta sala
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function RoomSummaryView({ room }: { room: RoomDetail }): JSX.Element {
  return (
    <div className={styles.summary}>
      <p className={styles.summaryName}>
        {room.emoji !== null ? (
          <span className={styles.summaryEmoji} aria-hidden="true">
            {room.emoji}
          </span>
        ) : null}
        {room.name}
      </p>
      {room.description !== null ? (
        <p className={styles.summaryText}>{room.description}</p>
      ) : null}
      <p className={styles.fine}>
        {room.memberCount} {room.memberCount === 1 ? 'participante' : 'participantes'} ·{' '}
        {room.soundCount} {room.soundCount === 1 ? 'som próprio' : 'sons próprios'}
      </p>
    </div>
  );
}
