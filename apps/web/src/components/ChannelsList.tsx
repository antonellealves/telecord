import { Link } from 'react-router-dom';
import type { ChannelSummary } from '@telecord/shared';
import styles from './ChannelsList.module.css';

interface ChannelsListProps {
  channels: ChannelSummary[];
}

/**
 * Canais na tela inicial — o ponto de partida para navegar por um grupo de
 * salas, do mesmo jeito que `ActiveRoomsList` é o ponto de partida para uma
 * sala avulsa.
 *
 * Sem serviço de contas ou sem canal nenhum criado ainda, a seção inteira não
 * aparece — não é uma lista vazia com aviso, é a ausência do conceito.
 */
export function ChannelsList({ channels }: ChannelsListProps): JSX.Element | null {
  if (channels.length === 0) return null;

  return (
    <section className={styles.block} aria-label="Canais">
      <h2 className={styles.heading}>Canais</h2>
      <ul className={styles.list}>
        {channels.map((channel) => (
          <li key={channel.slug}>
            <Link className={styles.channel} to={`/canal/${channel.slug}`}>
              <span className={styles.identity}>
                {channel.emoji !== null ? (
                  <span className={styles.emoji} aria-hidden="true">
                    {channel.emoji}
                  </span>
                ) : null}
                <span className={styles.name}>{channel.name}</span>
              </span>
              <span className={styles.meta}>
                {channel.roomCount} {channel.roomCount === 1 ? 'sala' : 'salas'}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
