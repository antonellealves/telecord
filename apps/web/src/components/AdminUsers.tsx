import { useCallback, useEffect, useState } from 'react';
import type { AdminUserRow } from '@telecord/shared';
import { useKeysetList } from '../hooks/useKeysetList';
import { fetchUsers, updateUser } from '../lib/admin';
import { ApiError } from '../lib/apiClient';
import { formatWhen } from './AdminLogs';
import { SearchIcon } from './icons';
import styles from './Admin.module.css';

const STATUSES: AdminUserRow['status'][] = ['ACTIVE', 'SUSPENDED', 'BANNED'];
const ROLES: AdminUserRow['role'][] = ['USER', 'ADMIN'];

interface Props {
  /** Id de quem está olhando: a própria linha não é editável. */
  selfId: string;
}

/**
 * Contas, com papel e situação editáveis.
 *
 * ## O que esta tela deliberadamente não tem
 *
 * **Senha.** Nem para ver, nem para trocar, nem hash. A rota do servidor monta
 * a linha campo a campo e `passwordHash` não está entre eles — não é uma
 * coluna escondida na exibição, é um dado que não sai do banco.
 *
 * **Entrar como.** Nenhum botão de assumir a identidade de outra pessoa.
 * Suporte se faz com o log e com a auditoria, que registram o que aconteceu;
 * um botão desses transformaria toda ação registrada em "pode ter sido o
 * administrador", e a trilha inteira perderia o valor.
 *
 * ## A própria linha
 *
 * Vem desabilitada, e o servidor recusa de qualquer forma. O único
 * administrador que se rebaixasse por engano deixaria a instalação sem ninguém
 * capaz de desfazer, e a saída seria editar o banco à mão.
 */
export function AdminUsers({ selfId }: Props): JSX.Element {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const fetchPage = useCallback(
    (cursor: string | null, signal: AbortSignal) => fetchUsers({ cursor, q: debounced }, signal),
    [debounced],
  );
  const list = useKeysetList<AdminUserRow>({ key: debounced, fetchPage });

  const apply = useCallback(
    async (user: AdminUserRow, patch: Partial<Pick<AdminUserRow, 'role' | 'status'>>) => {
      setSaving(user.id);
      setFailure(null);
      try {
        const updated = await updateUser(user.id, patch);
        // Troca a linha no lugar em vez de recarregar: recarregar levaria a
        // lista de volta à primeira página e perderia o que já foi rolado.
        list.replace((item) => item.id === user.id, updated);
      } catch (error) {
        setFailure(error instanceof ApiError ? error.message : 'Não deu para salvar.');
      } finally {
        setSaving(null);
      }
    },
    [list],
  );

  return (
    <div className={styles.card}>
      <div className={styles.filters}>
        <label className={styles.search}>
          <SearchIcon />
          <input
            className={styles.input}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar por e-mail, nome ou usuário"
            aria-label="Buscar contas"
          />
        </label>
        <button type="button" className={styles.ghost} onClick={list.reload}>
          Atualizar
        </button>
      </div>

      {failure !== null ? <p className={styles.error}>{failure}</p> : null}
      {list.error !== null ? <p className={styles.error}>{list.error}</p> : null}

      {list.isLoading ? (
        <p className={styles.muted}>Carregando…</p>
      ) : list.items.length === 0 ? (
        <p className={styles.muted}>Nenhuma conta encontrada.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Pessoa</th>
                <th>E-mail</th>
                <th>Situação</th>
                <th>Papel</th>
                <th>Entrou</th>
                <th>Visto</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((user) => {
                const isSelf = user.id === selfId;
                const busy = saving === user.id;
                return (
                  <tr key={user.id}>
                    <td>
                      {user.displayName}
                      <p className={styles.context}>@{user.username}</p>
                    </td>
                    <td className={styles.mono}>
                      {user.email}
                      {!user.emailVerified ? (
                        <p className={styles.context}>e-mail não confirmado</p>
                      ) : null}
                    </td>
                    <td>
                      <div className={styles.rowActions}>
                        <span className={`${styles.badge} ${statusClass(user.status)}`}>
                          {user.status}
                        </span>
                        <select
                          className={styles.miniSelect}
                          value={user.status}
                          disabled={isSelf || busy}
                          title={isSelf ? 'Você não muda a própria conta por aqui' : undefined}
                          onChange={(event) =>
                            void apply(user, {
                              status: event.target.value as AdminUserRow['status'],
                            })
                          }
                          aria-label={`Situação de ${user.displayName}`}
                        >
                          {STATUSES.map((status) => (
                            <option key={status} value={status}>
                              {status}
                            </option>
                          ))}
                        </select>
                      </div>
                    </td>
                    <td>
                      <div className={styles.rowActions}>
                        <span className={`${styles.badge} ${roleClass(user.role)}`}>{user.role}</span>
                        <select
                          className={styles.miniSelect}
                          value={user.role}
                          disabled={isSelf || busy}
                          title={isSelf ? 'Você não muda a própria conta por aqui' : undefined}
                          onChange={(event) =>
                            void apply(user, { role: event.target.value as AdminUserRow['role'] })
                          }
                          aria-label={`Papel de ${user.displayName}`}
                        >
                          {ROLES.map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                        </select>
                      </div>
                    </td>
                    <td className={styles.when}>{formatWhen(user.createdAt)}</td>
                    <td className={styles.when}>
                      {user.lastSeenAt === null ? 'nunca' : formatWhen(user.lastSeenAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className={styles.muted}>
        Suspender derruba as sessões abertas na hora. Não há como ler senha nem entrar como outra
        pessoa — nem por aqui, nem pela API.
      </p>

      {list.hasMore ? (
        <div className={styles.more}>
          <button
            type="button"
            className={styles.ghost}
            onClick={list.loadMore}
            disabled={list.isLoadingMore}
          >
            {list.isLoadingMore ? 'Carregando…' : 'Carregar mais'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function statusClass(status: AdminUserRow['status']): string {
  if (status === 'ACTIVE') return styles.statusACTIVE ?? '';
  if (status === 'SUSPENDED') return styles.statusSUSPENDED ?? '';
  return styles.statusBANNED ?? '';
}

function roleClass(role: AdminUserRow['role']): string {
  return (role === 'ADMIN' ? styles.roleADMIN : styles.roleUSER) ?? '';
}
