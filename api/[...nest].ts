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
import nest from '../apps/api/dist/src/vercel.js';

/*
 * O `export default` PRECISA ser uma função declarada aqui, e não o `nest`
 * reexportado direto.
 *
 * `export default nest` exporta um BINDING para o default de um módulo
 * CommonJS (`module.exports = handler`), e o empacotador de funções da Vercel
 * lê esse binding ao envolver o arquivo para achar o handler — cedo demais,
 * antes de a interop CJS→ESM ter resolvido o valor. O default chega
 * `undefined`, e a função morre no CARREGAMENTO, com
 * FUNCTION_INVOCATION_FAILED e sem stack: nem o handler roda, nem o 404 do
 * Express aparece.
 *
 * Medido em produção com dois arquivos idênticos a não ser por isto: o que
 * reexportava direto deu 500; o que declarava a própria função e chamava o
 * importado dentro respondeu 200. A diferença é só esta indireção.
 *
 * Envolver custa uma chamada de função por requisição e devolve o controle do
 * que é exportado para este arquivo.
 */
export default function handler(req: IncomingMessage, res: ServerResponse): void {
  nest(req, res);
}
