/**
 * Ponte entre o roteamento da Vercel e o serviço NestJS.
 *
 * Captura tudo sob `/api/` que não tenha função própria. `api/token.ts` e
 * `api/rooms.ts` continuam respondendo pelos caminhos deles: rota com segmento
 * fixo tem precedência sobre rota dinâmica, então a captura só recebe o resto.
 *
 * Importa a saída COMPILADA, e não a fonte. O Nest resolve dependência lendo o
 * tipo dos parâmetros do construtor em tempo de execução, o que exige
 * `emitDecoratorMetadata` — que o compilador de funções da Vercel não liga. Com
 * a fonte, todo `@Injectable` receberia `undefined` e o serviço quebraria no
 * boot. Por isso `pnpm build` compila `apps/api` antes do front.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
/*
 * Pelo NOME do pacote (`@telecord/api/vercel`), e NUNCA por um
 * `../apps/api/dist/...` relativo.
 *
 * A diferença é onde o Node procura as dependências de quem foi importado.
 * Esta função mora na raiz do repositório, e o pnpm isola: `@nestjs/*`,
 * `@prisma/client` e `reflect-metadata` existem só em `apps/api/node_modules`,
 * não no `node_modules` da raiz. Alcançado por caminho relativo, o
 * `require("@nestjs/core")` de dentro do `dist` resolvia a partir da RAIZ e não
 * achava nada — e a função morria na partida, antes de executar:
 * FUNCTION_INVOCATION_FAILED sem stack, com `x-vercel-id` de uma região só.
 *
 * Entrando pelo nome do pacote, o arquivo é alcançado dentro de `apps/api`, e
 * as dependências dele resolvem no `node_modules` de lá, como no Docker.
 * `@telecord/api` está nas dependências da raiz para o link existir.
 */
import nest from '@telecord/api/vercel';

/*
 * O `export default` PRECISA ser uma função declarada aqui, e não o `nest`
 * reexportado direto.
 *
 * `export default nest` exporta um BINDING para o default de um módulo
 * CommonJS (`module.exports = handler`), e o empacotador de funções da Vercel
 * lê esse binding ao envolver o arquivo para achar o handler — cedo demais,
 * antes de a interop CJS→ESM ter resolvido o valor.
 */
export default function handler(req: IncomingMessage, res: ServerResponse): void {
  nest(req, res);
}
