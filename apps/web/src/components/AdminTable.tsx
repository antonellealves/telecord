import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Page } from '@telecord/shared';
import { useKeysetList } from '../hooks/useKeysetList';
import { ApiError } from '../lib/apiClient';
import { SearchIcon } from './icons';
import styles from './Admin.module.css';

export interface Column<T> {
  header: string;
  /** O que desenhar na célula. Devolver `null` vira um traço. */
  cell: (row: T) => ReactNode;
}

/**
 * Ação destrutiva por linha: um botão que pede confirmação na própria linha e,
 * dando certo, tira a linha da lista.
 */
export interface RowAction<T> {
  label: string;
  busyLabel: string;
  title?: string;
  run: (row: T) => Promise<void>;
}

interface Props<T> {
  columns: Column<T>[];
  /** Sem isto, a tabela é só leitura. */
  rowAction?: RowAction<T>;
  fetchPage: (
    options: { cursor: string | null; q: string | null },
    signal: AbortSignal,
  ) => Promise<Page<T>>;
  rowKey: (row: T) => string;
  /** Sem isto, a aba não mostra campo de busca. */
  searchPlaceholder?: string;
  emptyLabel: string;
}

/**
 * Tabela paginada das abas de dados do painel.
 *
 * Existe para as cinco abas novas (salas, canais, sons, sessões, logins) não
 * serem cinco cópias do mesmo componente com os nomes das colunas trocados.
 * O que varia entre elas é só a lista de colunas e a função que busca a
 * página — o resto (busca com atraso, keyset, estado vazio, "carregar mais",
 * erro) é idêntico e vive aqui.
 *
 * `AdminUsers` e `AdminLogs` NÃO usam isto de propósito: as duas têm célula
 * que age — trocar papel, filtrar por nível —, e generalizar a ponto de caber
 * ação por célula transformaria este arquivo numa linguagem de tabela.
 *
 * `rowAction` é a exceção que cabe: UMA ação por linha, sempre no mesmo
 * formato (apagar, com confirmação), sem a célula precisar conhecer a lista.
 */
export function AdminTable<T>({
  columns,
  rowAction,
  fetchPage,
  rowKey,
  searchPlaceholder,
  emptyLabel,
}: Props<T>): JSX.Element {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  // Mesma espera do resto do painel: digitar não pode disparar uma consulta
  // por tecla contra uma tabela grande.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    (cursor: string | null, signal: AbortSignal) =>
      fetchPage({ cursor, q: debounced === '' ? null : debounced }, signal),
    [fetchPage, debounced],
  );
  const list = useKeysetList<T>({ key: debounced, fetchPage: load });

  // Dois cliques, na própria linha: o primeiro arma, o segundo apaga. Um
  // clique só, numa tabela densa, apagaria a linha vizinha por engano.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const runAction = async (row: T): Promise<void> => {
    if (rowAction === undefined) return;
    const key = rowKey(row);
    setBusy(key);
    setFailure(null);
    try {
      await rowAction.run(row);
      list.remove((item) => rowKey(item) === key);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'A ação não funcionou.');
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.filters}>
        {searchPlaceholder === undefined ? null : (
          <label className={styles.search}>
            <SearchIcon />
            <input
              className={styles.input}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
            />
          </label>
        )}
        <button type="button" className={styles.ghost} onClick={list.reload}>
          Atualizar
        </button>
      </div>

      {failure !== null ? <p className={styles.error}>{failure}</p> : null}
      {list.error !== null ? <p className={styles.error}>{list.error}</p> : null}

      {list.isLoading ? (
        <p className={styles.muted}>Carregando…</p>
      ) : list.items.length === 0 ? (
        <p className={styles.muted}>{emptyLabel}</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.header}>{column.header}</th>
                ))}
                {rowAction === undefined ? null : <th />}
              </tr>
            </thead>
            <tbody>
              {list.items.map((row) => {
                const key = rowKey(row);
                return (
                  <tr key={key}>
                    {columns.map((column) => (
                      <td key={column.header}>{column.cell(row) ?? '—'}</td>
                    ))}
                    {rowAction === undefined ? null : (
                      <td className={styles.actions}>
                        {confirming === key ? (
                          <>
                            <button
                              type="button"
                              className={styles.danger}
                              disabled={busy === key}
                              onClick={() => void runAction(row)}
                            >
                              {busy === key ? rowAction.busyLabel : 'Confirmar'}
                            </button>
                            <button
                              type="button"
                              className={styles.ghost}
                              disabled={busy === key}
                              onClick={() => setConfirming(null)}
                            >
                              Cancelar
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className={styles.danger}
                            disabled={busy !== null}
                            title={rowAction.title}
                            onClick={() => setConfirming(key)}
                          >
                            {rowAction.label}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
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

/** Tamanho legível. O painel mostra arquivo de som, que fica em KB ou MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Duração de sessão. `null` é sessão ABERTA, não duração zero — a diferença
 * importa: zero seria alguém que entrou e saiu na mesma hora.
 */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}min`;
}
