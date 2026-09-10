import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from '@telecord/shared';
import { badRequest } from './errors';

/**
 * Paginação por cursor, para todas as listagens do serviço.
 *
 * `OFFSET` está proibido pelo documento, e com razão. Dois motivos, e o segundo
 * é o que morde:
 *
 *  1. `LIMIT 50 OFFSET 10000` obriga o banco a produzir 10.050 linhas para
 *     jogar 10.000 fora. O custo cresce com a distância do início.
 *  2. A janela ANDA. Como o log recebe escrita o tempo todo, uma linha nova
 *     empurra tudo para a frente entre uma página e a próxima — e aí a mesma
 *     linha aparece nas duas, ou some sem nunca ter sido mostrada. Quem lê um
 *     log para investigar alguma coisa não pode conviver com isso.
 *
 * O cursor carrega a posição exata da última linha entregue: `(createdAt, id)`.
 * A página seguinte é `(createdAt, id) < (cursor)`, uma busca no índice
 * `[createdAt, id]` — custo igual na página 1 e na página 500.
 *
 * O `id` está ali para desempatar: `createdAt` tem milissegundos, e duas
 * escritas no mesmo milissegundo não são raras num log.
 */

export interface Keyset {
  at: Date;
  id: string;
}

export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url');
}

/**
 * Cursor inválido é erro de requisição, não motivo para devolver a primeira
 * página em silêncio — quem paginou errado ficaria em laço sem perceber.
 */
export function decodeCursor(raw: string | undefined): Keyset | null {
  if (raw === undefined || raw === '') return null;

  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const separator = decoded.indexOf('|');
  if (separator <= 0) {
    throw badRequest('invalid_cursor', 'Cursor inválido.');
  }

  const at = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(at.getTime()) || id === '') {
    throw badRequest('invalid_cursor', 'Cursor inválido.');
  }
  return { at, id };
}

export function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return PAGE_LIMIT_DEFAULT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw badRequest('invalid_limit', 'O limite precisa ser um inteiro positivo.');
  }
  // Teto, e não erro: um cliente pedindo 5.000 quer todas — dar 100 responde
  // isso, e a próxima página está no cursor.
  return Math.min(value, PAGE_LIMIT_MAX);
}

/**
 * A condição `(campo, id) < (cursor)` escrita como o Prisma aceita.
 *
 * Devolve `undefined` sem cursor, para entrar num `where` sem sujá-lo com uma
 * cláusula vazia. O tipo de saída é frouxo de propósito: cada chamador conhece
 * o `where` da sua tabela e faz o estreitamento — generalizar isso em tipo
 * custaria mais do que a condição de três linhas que ele guarda.
 */
export function keysetBefore(
  cursor: Keyset | null,
  field: string,
): Record<string, unknown> | undefined {
  if (cursor === null) return undefined;
  return {
    OR: [{ [field]: { lt: cursor.at } }, { [field]: cursor.at, id: { lt: cursor.id } }],
  };
}

/**
 * Monta a página a partir de UMA linha a mais do que o pedido.
 *
 * Pedir `limit + 1` e devolver `limit` é o que responde "tem mais?" sem um
 * `COUNT(*)` — que numa tabela de log é a consulta mais cara da rota inteira,
 * e serviria só para desenhar um botão.
 */
export function buildPage<Row, Item>(
  rows: Row[],
  limit: number,
  toItem: (row: Row) => Item,
  toCursor: (row: Row) => string,
): { items: Item[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(toItem),
    nextCursor: hasMore && last !== undefined ? toCursor(last) : null,
  };
}
