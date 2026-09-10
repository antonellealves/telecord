import { useNavigate } from 'react-router-dom';
import type { ChannelDetail } from '@telecord/shared';
import styles from './ChannelNav.module.css';

interface ChannelNavProps {
  channel: ChannelDetail;
  /** Slug da sala em que a pessoa está agora, para destacar na lista. */
  currentRoomSlug: string;
}

/**
 * Navegação entre as salas de um canal — o "transitável" do pedido.
 *
 * Clicar numa sala irmã navega para `/sala/:slug`, e é o `RoomPage` quem faz
 * o resto: `useParams` muda, a `LiveKitRoom` desmonta e remonta com o novo
 * `roomId`, o que desconecta da sala atual e conecta na nova. Não existe
 * salto "dentro" da mesma conexão — cada sala de um canal é uma `Room`
 * LiveKit própria, e a troca é sempre sair de uma e entrar noutra (ver
 * `PLANO.md`, decisão registrada explicitamente). O que este componente
 * poupa é a pessoa ter de voltar à tela inicial para trocar.
 */
export function ChannelNav({ channel, currentRoomSlug }: ChannelNavProps): JSX.Element {
  const navigate = useNavigate();

  return (
    <nav className={styles.nav} aria-label={`Salas do canal ${channel.name}`}>
      <span className={styles.channelLabel} title={channel.name}>
        {channel.emoji !== null ? (
          <span className={styles.channelEmoji} aria-hidden="true">
            {channel.emoji}
          </span>
        ) : null}
        {channel.name}
      </span>
      <ul className={styles.list}>
        {channel.rooms.map((room) => {
          const isCurrent = room.slug === currentRoomSlug;
          return (
            <li key={room.slug}>
              <button
                type="button"
                className={`${styles.room} ${isCurrent ? styles.roomCurrent : ''}`}
                onClick={() => {
                  if (!isCurrent) navigate(`/sala/${room.slug}`);
                }}
                aria-current={isCurrent}
                title={isCurrent ? `Você está em ${room.name}` : `Ir para ${room.name}`}
              >
                {room.emoji !== null ? (
                  <span className={styles.roomEmoji} aria-hidden="true">
                    {room.emoji}
                  </span>
                ) : null}
                {room.name}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
