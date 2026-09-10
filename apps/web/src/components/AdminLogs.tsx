import { useCallback, useEffect, useMemo, useState } from 'react';
import { LOG_LEVELS, type LogLevel, type SystemLogEntry } from '@telecord/shared';
import { useKeysetList } from '../hooks/useKeysetList';
import { fetchLogScopes, fetchLogs } from '../lib/admin';
import { SearchIcon } from './icons';
import styles from './Admin.module.css';

/**
 * O log técnico, com filtro e paginação por cursor.
 *
 * ## Por que a busca tem atraso
 *
 * Cada tecla mudaria o filtro, e cada mudança de filtro é uma consulta com
 * `LIKE` numa tabela que é a que mais cresce no sistema. Trezentos
 * milissegundos de espera transformam "erro" de cinco consultas em uma.
 *
 * ## O que NÃO aparece aqui
 *
 * Senha, token e cabeçalho de autorização. Não porque esta tela os esconda —
 * ela mostra o que está gravado —, mas porque `redact.ts` os remove antes da
 * escrita, no servidor. Uma tela que filtrasse na exibição continuaria com o
 * segredo no banco, ao alcance de qualquer consulta.
 */
export function AdminLogs(): JSX.Element {
  const [level, setLevel] = useState<LogLevel | ''>('');
  const [scope, setScope] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchLogScopes(controller.signal)
      .then(setScopes)
      // Sem escopos o filtro vira só "todos", e o resto da tela continua
      // funcionando. Não é motivo para uma faixa vermelha.
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const fetchPage = useCallback(
    (cursor: string | null, signal: AbortSignal) =>
      fetchLogs(
        { cursor, level: level === '' ? null : level, scope: scope === '' ? null : scope, q: debounced },
        signal,
      ),
    [level, scope, debounced],
  );

  const list = useKeysetList<SystemLogEntry>({
    key: `${level}|${scope}|${debounced}`,
    fetchPage,
  });

  const rows = useMemo(() => list.items, [list.items]);

  return (
    <div className={styles.card}>
      <div className={styles.filters}>
        <label className={styles.search}>
          <SearchIcon />
          <input
            className={styles.input}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar na mensagem, no evento ou na sala"
            aria-label="Buscar no log"
          />
        </label>

        <select
          className={styles.select}
          value={level}
          onChange={(event) => setLevel(event.target.value as LogLevel | '')}
          aria-label="Filtrar por nível"
        >
          <option value="">Todos os níveis</option>
          {LOG_LEVELS.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>

        <select
          className={styles.select}
          value={scope}
          onChange={(event) => setScope(event.target.value)}
          aria-label="Filtrar por escopo"
        >
          <option value="">Todos os escopos</option>
          {scopes.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>

        <button type="button" className={styles.ghost} onClick={list.reload}>
          Atualizar
        </button>
      </div>

      {list.error !== null ? <p className={styles.error}>{list.error}</p> : null}

      {list.isLoading ? (
        <p className={styles.muted}>Carregando…</p>
      ) : rows.length === 0 ? (
        <p className={styles.muted}>
          Nada registrado com esses filtros. O log técnico guarda 30 dias — depois disso o próprio
          TiDB apaga.
        </p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Quando</th>
                <th>Nível</th>
                <th>Escopo</th>
                <th>Evento</th>
                <th>Mensagem</th>
                <th>Quem</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <tr key={entry.id}>
                  <td className={styles.when}>{formatWhen(entry.createdAt)}</td>
                  <td>
                    <span className={`${styles.badge} ${levelClass(entry.level)}`}>{entry.level}</span>
                  </td>
                  <td className={styles.mono}>{entry.scope}</td>
                  <td className={styles.mono}>{entry.event}</td>
                  <td className={styles.message}>
                    {entry.message}
                    {entry.context !== null ? (
                      <p className={styles.context}>{JSON.stringify(entry.context)}</p>
                    ) : null}
                    {entry.roomSlug !== null ? (
                      <p className={styles.context}>sala: {entry.roomSlug}</p>
                    ) : null}
                  </td>
                  <td className={styles.mono}>{entry.userLabel ?? (entry.ip ?? '—')}</td>
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

export function levelClass(level: LogLevel): string {
  switch (level) {
    case 'ERROR':
      return styles.levelERROR ?? '';
    case 'WARN':
      return styles.levelWARN ?? '';
    case 'INFO':
      return styles.levelINFO ?? '';
    default:
      return styles.levelDEBUG ?? '';
  }
}

/**
 * Data e hora no fuso de quem olha.
 *
 * Diferente das SÉRIES do painel, que são bucketizadas em UTC no servidor:
 * ali o dia precisa ser o mesmo para todo administrador, aqui o instante é
 * pontual e mostrá-lo no relógio de quem lê é o que permite cruzar com "isso
 * aconteceu por volta das três".
 */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
