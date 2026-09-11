import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Page } from '@telecord/shared';
import { useKeysetList } from '../hooks/useKeysetList';
import { SearchIcon } from './icons';
import styles from './Admin.module.css';

export interface Column<T> {
  header: string;
  /** O que desenhar na célula. Devolver `null` vira um traço. */
  cell: (row: T) => ReactNode;
}

interface Props<T> {
  columns: Column<T>[];
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
 */
export function AdminTable<T>({
  columns,
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
              </tr>
            </thead>
            <tbody>
              {list.items.map((row) => (
                <tr key={rowKey(row)}>
                  {columns.map((column) => (
                    <td key={column.header}>{column.cell(row) ?? '—'}</td>
                  ))}
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
