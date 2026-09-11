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
 * no `apps/api/package.json`, e o `node-linker=hoisted` do `.npmrc` põe as
 * dependências do serviço ao alcance da função, que roda de `/var/task/api/`.
 *
 * ATENÇÃO: esta função AINDA não sobe na Vercel — ver o bloco no fim do
 * arquivo antes de mexer aqui.
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

/*
 * ESTADO: quebrado em produção, e o que já foi eliminado.
 *
 * Sintoma: FUNCTION_INVOCATION_FAILED, `x-vercel-id` de uma região só
 * (`gru1::`, sem o `::iad1::` de quem executou), portanto a função morre ANTES
 * de rodar. `/api/nada` dá 500 em vez do 404 do Express, e toda rota do
 * serviço (`/api/auth/*`, `/api/admin/*`, `/api/channels/*`) dá 404 — inclusive
 * `POST /api/auth/register`, o cadastro.
 *
 * Medido em produção, por bisseção:
 *   1. catch-all mínimo, sem import nenhum     -> 200. Arquivo, nome
 *      `[...nest]` e roteamento estão BONS; o `...nest=nada` chega na query.
 *   2. o mesmo + import do serviço             -> 500 antes de executar.
 *   3. só `@prisma/client`, em try/catch       -> reportou
 *      "Cannot find package '@prisma/client' imported from
 *      /var/task/api/[...nest].js" — daí o `node-linker=hoisted`.
 *   4. depois do hoisted, com TUDO em try/catch -> ainda 500 antes de executar,
 *      ou seja, o try/catch nem chega a rodar. O que falha é montar/carregar o
 *      pacote da função, não o código deste arquivo.
 *
 * Já descartado: nome do arquivo, o glob de `functions` (o minimatch confirma
 * que `api/*.ts` casa com `api/[...nest].ts`), reexport de binding CJS,
 * extensão em import relativo, `$connect()` no boot e tamanho do engine do
 * Prisma (só o `rhel-openssl-3.0.x`, de 17MB, vai para o runner Linux).
 *
 * Próximo passo é ler o LOG DE BUILD da função no inspector da Vercel, que é a
 * única fonte ainda não consultada e a que diz por que o pacote não monta.
 * Alternativa de fundo, já cogitada no PLANO.md §2.3: tirar o Nest da Vercel e
 * subir `apps/api` como serviço (Railway/Fly/Render), deixando aqui só a SPA e
 * as duas funções magras, que nunca falharam.
 */
