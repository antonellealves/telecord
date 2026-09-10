import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  CHANNEL_DESCRIPTION_MAX_LENGTH,
  CHANNEL_NAME_MAX_LENGTH,
  ROOM_ID_MAX_LENGTH,
  normalizeRoomId,
  validateChannelDescription,
  validateChannelName,
  validateRoomId,
  type ChannelDetail,
  type ChannelMemberRole,
  type RoomVisibility,
} from '@telecord/shared';
import { AmbientGradient } from '../components/AmbientGradient';
import { StatusScreen } from '../components/StatusScreen';
import { useAuth } from '../hooks/useAuth';
import {
  addRoomToChannel,
  createChannel,
  fetchChannel,
  removeChannelMember,
  removeRoomFromChannel,
  reorderChannelRooms,
  setChannelMemberRole,
  updateChannel,
} from '../lib/channels';
import { ApiError } from '../lib/apiClient';
import styles from './ChannelPage.module.css';
import statusStyles from '../components/StatusScreen.module.css';

const ROLE_LABEL: Record<ChannelMemberRole, string> = {
  OWNER: 'dono',
  MOD: 'moderação',
  MEMBER: 'membro',
};

/**
 * A página de um canal: nome, salas dentro (com reordenar) e membros.
 *
 * ## Por que é uma PÁGINA, não um painel dentro de sala
 *
 * Canal não é um lugar que se entra — não tem conexão de voz. É metadado e
 * uma lista de salas, então cabe numa rota própria (`/canal/:slug`) que
 * existe mesmo sem ninguém estar conectado a nada, diferente da ficha de sala
 * (`RoomPanel`), que só faz sentido dentro do `RoomShell` porque descreve a
 * sala em que a pessoa já está.
 *
 * ## Reordenar
 *
 * Arrastar-e-soltar de verdade pediria uma biblioteca de drag-and-drop só
 * para isto; os botões "subir"/"descer" fazem o mesmo com HTML puro, e a
 * rota (`reorderChannelRooms`) já aceita a lista inteira de uma vez — o que
 * ela troca é só a ORDEM de dois elementos no array antes de mandar.
 */
export function ChannelPage(): JSX.Element {
  const params = useParams<{ channelSlug: string }>();
  const slug = normalizeRoomId(params.channelSlug ?? '');
  const navigate = useNavigate();
  const { status, user } = useAuth();
  const isSignedIn = status === 'autenticado' && user !== null;

  const [channel, setChannel] = useState<ChannelDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [emoji, setEmoji] = useState('');
  const [visibility, setVisibility] = useState<RoomVisibility>('PUBLIC');
  const [roomToAdd, setRoomToAdd] = useState('');

  const adopt = (detail: ChannelDetail): void => {
    setChannel(detail);
    setMissing(false);
    setName(detail.name);
    setDescription(detail.description ?? '');
    setEmoji(detail.emoji ?? '');
    setVisibility(detail.visibility);
  };

  useEffect(() => {
    if (validateRoomId(slug) !== null) return undefined;
    const controller = new AbortController();
    setIsLoading(true);

    void fetchChannel(slug, controller.signal)
      .then((detail) => {
        if (controller.signal.aborted) return;
        adopt(detail);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 404) {
          setMissing(true);
          setName(slug);
          return;
        }
        setFailure(
          error instanceof ApiError ? error.message : 'Não deu para carregar o canal.',
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [slug]);

  const run = useCallback(async (action: () => Promise<ChannelDetail | void>): Promise<void> => {
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
    const nameError = validateChannelName(name);
    const descriptionError = validateChannelDescription(description);
    if (nameError !== null || descriptionError !== null) {
      setFailure(nameError ?? descriptionError);
      return;
    }

    const payload = { name, description, emoji, visibility };
    void run(() =>
      missing ? createChannel({ slug, ...payload }) : updateChannel(slug, payload),
    );
  };

  const addRoom = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const roomSlugError = validateRoomId(roomToAdd);
    if (roomSlugError !== null) {
      setFailure(roomSlugError);
      return;
    }
    void run(() => addRoomToChannel(slug, normalizeRoomId(roomToAdd))).then(() =>
      setRoomToAdd(''),
    );
  };

  const move = (index: number, direction: -1 | 1): void => {
    if (channel === null) return;
    const target = index + direction;
    if (target < 0 || target >= channel.rooms.length) return;
    const order = channel.rooms.map((room) => room.slug);
    const [moved] = order.splice(index, 1);
    order.splice(target, 0, moved as string);
    void run(() => reorderChannelRooms(slug, order));
  };

  if (validateRoomId(slug) !== null) {
    return (
      <StatusScreen variant="error" title="Endereço de canal inválido" message="Esse endereço não parece um canal.">
        <Link className={`${statusStyles.button} ${statusStyles.primary}`} to="/">
          Voltar ao início
        </Link>
      </StatusScreen>
    );
  }

  const canManage = channel !== null && (channel.myRole === 'OWNER' || channel.myRole === 'MOD');
  const isOwner = channel !== null && channel.myRole === 'OWNER';

  return (
    <>
      <AmbientGradient variant="subtle" />
      <div className={styles.page}>
        <div className={styles.shell}>
          <header className={styles.header}>
            <Link className={styles.back} to="/">
              ← início
            </Link>
            {channel !== null ? (
              <h1 className={styles.title}>
                {channel.emoji !== null ? (
                  <span className={styles.titleEmoji} aria-hidden="true">
                    {channel.emoji}
                  </span>
                ) : null}
                {channel.name}
              </h1>
            ) : (
              <h1 className={styles.title}>{slug}</h1>
            )}
          </header>

          {failure !== null ? <p className={styles.error}>{failure}</p> : null}

          {isLoading ? (
            <p className={styles.muted}>Carregando…</p>
          ) : (
            <>
              {!isSignedIn ? (
                <p className={styles.muted}>
                  {missing
                    ? 'Este canal ainda não existe. Entre com uma conta para criá-lo.'
                    : 'Entre com uma conta para administrar este canal.'}
                </p>
              ) : missing || canManage ? (
                <form className={styles.form} onSubmit={submit}>
                  {missing ? (
                    <p className={styles.muted}>
                      Ninguém criou este canal ainda. Quem der o nome fica como dono.
                    </p>
                  ) : null}
                  <label className={styles.field}>
                    <span className={styles.label}>Nome</span>
                    <input
                      className={styles.input}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      maxLength={CHANNEL_NAME_MAX_LENGTH}
                      placeholder="Jogos"
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
                        aria-label="Emoji do canal"
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
                      maxLength={CHANNEL_DESCRIPTION_MAX_LENGTH}
                      placeholder="Do que é esse canal"
                    />
                  </label>
                  <button type="submit" className={styles.submit} disabled={busy}>
                    {busy ? 'Salvando…' : missing ? 'Criar canal' : 'Salvar'}
                  </button>
                </form>
              ) : null}

              {channel !== null ? (
                <>
                  <section className={styles.section}>
                    <h2 className={styles.subheading}>
                      Salas {channel.rooms.length > 0 ? `(${channel.rooms.length})` : ''}
                    </h2>
                    {channel.rooms.length === 0 ? (
                      <p className={styles.muted}>Nenhuma sala neste canal ainda.</p>
                    ) : (
                      <ul className={styles.roomList}>
                        {channel.rooms.map((room, index) => (
                          <li key={room.slug} className={styles.roomRow}>
                            <button
                              type="button"
                              className={styles.roomLink}
                              onClick={() => navigate(`/sala/${room.slug}`)}
                            >
                              {room.emoji !== null ? (
                                <span className={styles.roomEmoji} aria-hidden="true">
                                  {room.emoji}
                                </span>
                              ) : null}
                              {room.name}
                            </button>
                            {canManage ? (
                              <span className={styles.roomActions}>
                                <button
                                  type="button"
                                  className={styles.miniButton}
                                  disabled={busy || index === 0}
                                  onClick={() => move(index, -1)}
                                  aria-label={`Subir ${room.name}`}
                                >
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  className={styles.miniButton}
                                  disabled={busy || index === channel.rooms.length - 1}
                                  onClick={() => move(index, 1)}
                                  aria-label={`Descer ${room.name}`}
                                >
                                  ↓
                                </button>
                                <button
                                  type="button"
                                  className={styles.remove}
                                  disabled={busy}
                                  onClick={() =>
                                    void run(() => removeRoomFromChannel(slug, room.slug))
                                  }
                                  title={`Tirar ${room.name} deste canal (a sala continua existindo)`}
                                >
                                  ×
                                </button>
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}

                    {canManage ? (
                      <form className={styles.addRoomForm} onSubmit={addRoom}>
                        <input
                          className={styles.input}
                          value={roomToAdd}
                          onChange={(event) => setRoomToAdd(event.target.value)}
                          maxLength={ROOM_ID_MAX_LENGTH}
                          placeholder="endereço de uma sala já existente"
                          aria-label="Endereço da sala a acrescentar"
                        />
                        <button type="submit" className={styles.addRoomButton} disabled={busy}>
                          Acrescentar
                        </button>
                      </form>
                    ) : null}
                    <p className={styles.fine}>
                      Tirar uma sala do canal não a apaga — ela continua existindo e entrável pelo
                      endereço dela.
                    </p>
                  </section>

                  {channel.members.length > 0 ? (
                    <section className={styles.section}>
                      <h2 className={styles.subheading}>Quem administra</h2>
                      <ul className={styles.memberList}>
                        {channel.members.map((member) => (
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
                                      setChannelMemberRole(
                                        slug,
                                        member.userId,
                                        event.target.value as ChannelMemberRole,
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
                                  onClick={() =>
                                    void run(() => removeChannelMember(slug, member.userId))
                                  }
                                  title={`Tirar ${member.displayName} do canal`}
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
                      {user !== null && channel.myRole !== null && channel.myRole !== 'OWNER' ? (
                        <button
                          type="button"
                          className={styles.leave}
                          disabled={busy}
                          onClick={() => void run(() => removeChannelMember(slug, user.id))}
                        >
                          sair deste canal
                        </button>
                      ) : null}
                    </section>
                  ) : null}
                </>
              ) : null}
            </>
          )}
        </div>
      </div>
    </>
  );
}
