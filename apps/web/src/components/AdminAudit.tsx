import { useCallback } from 'react';
import type { AuditLogEntry } from '@telecord/shared';
import { useKeysetList } from '../hooks/useKeysetList';
import { fetchAudit } from '../lib/admin';
import { formatWhen } from './AdminLogs';
import styles from './Admin.module.css';

/**
 * A trilha de auditoria: quem fez, em quem, e o que mudou.
 *
 * Separada do log técnico porque responde a outra pergunta e tem outra
 * retenção. O log diz o que o sistema fez e expira em 30 dias; a auditoria diz
 * o que as PESSOAS fizeram e não expira — expirá-la seria apagar a única cópia
 * da resposta para a pergunta que se faz meses depois.
 *
 * Cada linha mostra o antes e o depois quando eles existem. Sem isso, "alterou
 * a conta de fulano" não diz o que foi alterado, e a trilha vira uma lista de
 * verbos.
 */
export function AdminAudit(): JSX.Element {
  const fetchPage = useCallback(
    (cursor: string | null, signal: AbortSignal) => fetchAudit(cursor, signal),
    [],
  );
  const list = useKeysetList<AuditLogEntry>({ key: 'audit', fetchPage });

  return (
    <div className={styles.card}>
      <div className={styles.filters}>
        <p className={styles.muted}>
          Registro permanente das ações administrativas. Não expira, ao contrário do log técnico.
        </p>
        <button type="button" className={styles.ghost} onClick={list.reload}>
          Atualizar
        </button>
      </div>

      {list.error !== null ? <p className={styles.error}>{list.error}</p> : null}

      {list.isLoading ? (
        <p className={styles.muted}>Carregando…</p>
      ) : list.items.length === 0 ? (
        <p className={styles.muted}>Nenhuma ação registrada ainda.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Quando</th>
                <th>Quem</th>
                <th>Ação</th>
                <th>O quê</th>
                <th>Mudança</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((entry) => (
                <tr key={entry.id}>
                  <td className={styles.when}>{formatWhen(entry.createdAt)}</td>
                  {/* O nome vem congelado do momento do ato: conta renomeada
                      ou apagada depois não apaga quem era na hora. */}
                  <td>{entry.actorLabel}</td>
                  <td className={styles.mono}>{entry.action}</td>
                  <td className={styles.message}>
                    {entry.summary}
                    <p className={styles.context}>
                      {entry.targetType}: {entry.targetId}
                    </p>
                  </td>
                  <td>
                    <div className={styles.diff}>
                      {entry.before !== null ? (
                        <span className={styles.diffBefore}>− {JSON.stringify(entry.before)}</span>
                      ) : null}
                      {entry.after !== null ? (
                        <span className={styles.diffAfter}>+ {JSON.stringify(entry.after)}</span>
                      ) : null}
                      {entry.before === null && entry.after === null ? '—' : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
