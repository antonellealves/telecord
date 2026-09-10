import { useCallback, useEffect, useRef, useState } from 'react';
import type { Page } from '@telecord/shared';
import { ApiError } from '../lib/apiClient';

export interface KeysetList<T> {
  items: T[];
  isLoading: boolean;
  /** Carregando a PRÓXIMA página. A lista já tem conteúdo na tela. */
  isLoadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
  /** Troca uma linha no lugar, depois de editá-la. Evita recarregar a página. */
  replace: (matches: (item: T) => boolean, next: T) => void;
}

interface Options<T> {
  /**
   * Muda quando o FILTRO muda, e só então.
   *
   * É o que separa "mostrar outra coisa" de "mostrar mais do mesmo": mudar a
   * chave zera a lista e volta à primeira página; `loadMore` acrescenta. Sem
   * essa separação, trocar de filtro no meio da rolagem misturaria resultados
   * de dois filtros na mesma lista.
   */
  key: string;
  fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<Page<T>>;
}

/**
 * Lista paginada por cursor, com "carregar mais".
 *
 * O mesmo comportamento serve às três listas do painel — log, auditoria e
 * contas —, e escrevê-lo três vezes seria três chances de esquecer o
 * `AbortController`. A parte que erra fácil é justamente essa: sem cancelar a
 * requisição anterior, trocar de filtro duas vezes rápido deixa duas respostas
 * a caminho, e a que chegar por último ganha — que pode ser a do filtro
 * antigo.
 */
export function useKeysetList<T>({ key, fetchPage }: Options<T>): KeysetList<T> {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Por referência: a função é recriada a cada render de quem chama, e como
  // dependência do efeito ela recarregaria a lista sem parar.
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const abortRef = useRef<AbortController | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);

    void (async () => {
      try {
        const page = await fetchRef.current(null, controller.signal);
        if (controller.signal.aborted) return;
        setItems(page.items);
        setCursor(page.nextCursor);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setItems([]);
        setCursor(null);
        setError(failure instanceof ApiError ? failure.message : 'Não deu para carregar.');
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    })();

    return () => controller.abort();
  }, [key, reloadToken]);

  const loadMore = useCallback(() => {
    if (cursor === null) return;
    setIsLoadingMore(true);
    const controller = new AbortController();

    void (async () => {
      try {
        const page = await fetchRef.current(cursor, controller.signal);
        // Acrescenta em vez de substituir; o cursor garante que não repete.
        setItems((current) => [...current, ...page.items]);
        setCursor(page.nextCursor);
      } catch (failure) {
        setError(failure instanceof ApiError ? failure.message : 'Não deu para carregar mais.');
      } finally {
        setIsLoadingMore(false);
      }
    })();
  }, [cursor]);

  const replace = useCallback((matches: (item: T) => boolean, next: T) => {
    setItems((current) => current.map((item) => (matches(item) ? next : item)));
  }, []);

  return {
    items,
    isLoading,
    isLoadingMore,
    error,
    hasMore: cursor !== null,
    loadMore,
    reload: () => setReloadToken((value) => value + 1),
    replace,
  };
}
