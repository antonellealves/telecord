/**
 * Filtro que impede credencial de entrar no log.
 *
 * "Nunca logar senha, token, refresh token ou payload de mídia" é uma regra
 * que não se cumpre com disciplina: basta um `context: { ...body }` escrito com
 * pressa, num caminho de erro que ninguém revisa, e a senha de alguém está no
 * banco em texto claro — e agora ela vaza junto com o log, que é a tabela que
 * mais gente consegue ler.
 *
 * Então a regra vira código, e fica no caminho obrigatório: `LogService` passa
 * TUDO por aqui antes de escrever. Não há como registrar contexto sem passar.
 *
 * O filtro age por duas vias, porque uma só não fecha:
 *
 *  - pelo NOME do campo (`password`, `token`, `authorization`…), que pega o
 *    caso comum;
 *  - pelo FORMATO do valor, que pega o caso em que o campo se chama `dados` e
 *    dentro dele tem um JWT.
 *
 * Além disso corta profundidade, largura e comprimento. Um log não é um dump:
 * uma linha de contexto com dez mil chaves é um problema de armazenamento
 * fingindo ser diagnóstico.
 */

export const HIDDEN = '[oculto]';

/** Nomes cujo VALOR nunca é registrado, custe o que custar ao diagnóstico. */
const SENSITIVE_KEY =
  /senha|password|passwd|secret|token|authorization|cookie|credential|api[-_]?key|private[-_]?key|refresh/i;

/**
 * Formatos que denunciam credencial mesmo num campo de nome inocente.
 * A chave PEM está aqui porque é o material que assina toda sessão do sistema.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, // JWT: header.payload.assinatura
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^Bearer\s+\S{16,}/i,
];

const MAX_DEPTH = 4;
const MAX_KEYS = 32;
const MAX_ARRAY = 20;
const MAX_STRING = 300;

function redactValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    if (SECRET_SHAPES.some((shape) => shape.test(value))) {
      return HIDDEN;
    }
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  // Data vira ISO; qualquer outra coisa exótica (função, símbolo, classe) some.
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (depth >= MAX_DEPTH) {
    return '[profundo demais]';
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => redactValue(item, depth + 1));
    return value.length > MAX_ARRAY ? [...items, `…+${value.length - MAX_ARRAY}`] : items;
  }

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    let count = 0;
    for (const key of Object.keys(source)) {
      if (count >= MAX_KEYS) {
        output['…'] = `+${Object.keys(source).length - MAX_KEYS} campos`;
        break;
      }
      output[key] = SENSITIVE_KEY.test(key) ? HIDDEN : redactValue(source[key], depth + 1);
      count += 1;
    }
    return output;
  }

  return undefined;
}

/**
 * Prepara o contexto para gravação. Devolve `null` quando não sobra nada —
 * coluna nula ocupa menos e diz a mesma coisa que um objeto vazio.
 */
export function redactContext(context: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (context === undefined) return null;
  const cleaned = redactValue(context, 0);
  if (typeof cleaned !== 'object' || cleaned === null || Array.isArray(cleaned)) {
    return null;
  }
  const result = cleaned as Record<string, unknown>;
  return Object.keys(result).length === 0 ? null : result;
}

/** Mesmo tratamento para o `before`/`after` da auditoria. */
export function redactSnapshot(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  return redactContext(value as Record<string, unknown>);
}
