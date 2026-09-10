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
import handler from '../apps/api/dist/src/vercel.js';

export default handler;

/*
 * Nota sobre o `vercel.json`: NÃO existe entrada específica para este arquivo
 * em `functions`. O glob é interpretado por minimatch, e `[...nest]` ali viraria
 * uma classe de caracteres — casaria com `api/n.ts`, nunca com este arquivo. A
 * configuração seria ignorada em silêncio. Quem cobre esta função é o
 * `api/*.ts`, onde o `*` casa com o nome literal, colchetes e tudo.
 */
