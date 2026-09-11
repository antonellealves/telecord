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
 *
 * Entra pelo NOME do pacote (`@telecord/api/vercel`), declarado em `exports`
 * no `apps/api/package.json`. O que torna isso possível em tempo de execução é
 * o `node-linker=hoisted` do `.npmrc`: a função roda de `/var/task/api/`, e com
 * o isolamento padrão do pnpm as dependências do serviço ficariam só em
 * `apps/api/node_modules`, fora do alcance dela.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import nest from '@telecord/api/vercel';

/*
 * O `export default` é uma função declarada AQUI, e não o `nest` reexportado
 * direto: `export default nest` exporta um binding para o default de um módulo
 * CommonJS, e o empacotador da Vercel lê esse binding ao envolver o arquivo,
 * antes de a interop CJS→ESM ter resolvido o valor.
 */
export default function handler(req: IncomingMessage, res: ServerResponse): void {
  nest(req, res);
}
