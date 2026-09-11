/**
 * Tipo do serviço empacotado por `scripts/bundle-api.mjs`.
 *
 * O `.cjs` é saída de build e não é versionado, então sem esta declaração o
 * `tsc` local não teria o que ler. Um `@ts-expect-error` no import não serve:
 * na Vercel o bundle EXISTE na hora da checagem, a diretiva fica sem erro para
 * suprimir e o build cai com TS2578.
 *
 * O padrão é com curinga porque declaração de módulo por caminho relativo não
 * casa com o import — só `declare module '*...'` alcança um arquivo assim.
 */
declare module '*/nest.cjs' {
  import type { IncomingMessage, ServerResponse } from 'node:http';
  const handler: (req: IncomingMessage, res: ServerResponse) => void;
  export default handler;
}
