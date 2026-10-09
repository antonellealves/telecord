/**
 * Uma linha de JSON por evento, no stdout — é o que `docker compose logs`
 * mostra e o que dá para filtrar com `jq`. Nunca carrega token nem segredo:
 * quem chama passa só identificadores.
 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function log(fields: LogFields): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ scope: 'mediasoup-sfu', ...fields }));
}
