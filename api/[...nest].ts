/**
 * Ponte entre o roteamento da Vercel e o serviço NestJS.
 *
 * Captura tudo sob `/api/` que não tenha função própria. `api/token.ts` e
 * `api/rooms.ts` continuam respondendo pelos caminhos deles: rota com segmento
 * fixo tem precedência sobre rota dinâmica, então a captura só recebe o resto.
 *
 * CARREGA UM BUNDLE, e não o `dist` do serviço. O log de build da Vercel
 * mostra por quê: depois do `buildCommand`, cada arquivo de `api/` é compilado
 * numa ETAPA SEPARADA, com o próprio "Installing dependencies...", que não
 * enxerga o que o build do monorepo produziu — `apps/api/dist` não está lá, e
 * `packages/shared/dist` é o do lockfile. Alcançar o serviço daqui por caminho
 * relativo, por nome de pacote ou com `node-linker=hoisted` dependia, nos três
 * casos, de resolver algo que naquele instante não existe.
 *
 * `scripts/bundle-api.mjs` resolve antes: empacota o serviço num `.cjs` sem
 * dependência externa, em `api-bundle/` — FORA de `api/`, porque todo
 * `.js`/`.cjs` dentro de `api/` vira candidato a função serverless própria no
 * roteamento zero-config, e o cliente do Prisma sozinho traz mais de dez.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import nest from '../api-bundle/bundle/nest.cjs';

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
