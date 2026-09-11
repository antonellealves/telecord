/**
 * Ponte entre o roteamento da Vercel e o serviço NestJS.
 *
 * Captura tudo sob `/api/` que não tenha função própria. `api/token.ts` e
 * `api/rooms.ts` continuam respondendo pelos caminhos deles: rota com segmento
 * fixo tem precedência sobre rota dinâmica, então a captura só recebe o resto.
 *
 * CARREGA UM BUNDLE, e não o `dist` do serviço. O motivo está no log de build
 * da Vercel: depois do `buildCommand`, cada arquivo de `api/` é compilado numa
 * ETAPA SEPARADA, que roda o próprio "Installing dependencies..." e não
 * enxerga o que o build do monorepo produziu — `apps/api/dist` não está lá, e
 * `packages/shared/dist` está desatualizado. Toda tentativa de alcançar o
 * serviço a partir daqui (caminho relativo, nome de pacote com `exports`,
 * `node-linker=hoisted`) dependia de resolver algo que, naquele instante, não
 * existe, e a função morria na partida com FUNCTION_INVOCATION_FAILED.
 *
 * `scripts/bundle-api.mjs` resolve isso antes: empacota o serviço inteiro num
 * `.cjs` sem dependência externa e deixa o cliente do Prisma ao lado. Aqui só
 * sobra um caminho relativo dentro de `api/`, que a etapa de funções enxerga.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — gerado por `scripts/bundle-api.mjs` no build, sem tipos.
import nest from './_bundle/nest.cjs';

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;

/*
 * O `export default` é uma função declarada AQUI, e não o `nest` reexportado
 * direto: `export default nest` exporta um binding para o default de um módulo
 * CommonJS, e o empacotador da Vercel lê esse binding ao envolver o arquivo,
 * antes de a interop CJS→ESM ter resolvido o valor.
 */
export default function handler(req: IncomingMessage, res: ServerResponse): void {
  (nest as NodeHandler)(req, res);
}
