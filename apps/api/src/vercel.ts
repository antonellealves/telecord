import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
/*
 * `ExpressAdapter` entra como VALOR, e não só como tipo.
 *
 * Sem isto, `@nestjs/platform-express` não aparece em lugar nenhum do JS
 * compilado: as três referências no serviço eram `import type`, que o
 * compilador apaga. Quem carregava o pacote era o próprio Nest, lá dentro do
 * `NestFactory.create`, por um `require` preguiçoso dentro de callback
 * (`loadAdapter`) — invisível para a análise estática que monta o pacote da
 * função na Vercel. O pacote ficava de fora, o `create` não achava o adaptador
 * e a função morria na PARTIDA: FUNCTION_INVOCATION_FAILED sem stack, com o
 * id de uma região só, que foi o sintoma o tempo todo.
 *
 * Passar o adaptador à mão faz a dependência ser real e rastreável, e ainda
 * tira um `require` dinâmico do caminho de boot de cada instância fria.
 */
import { ExpressAdapter, type NestExpressApplication } from '@nestjs/platform-express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { CONFIG, type AppConfig } from './common/config';

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Entrada do serviço quando ele roda como função da Vercel.
 *
 * A aplicação é construída UMA vez por instância e guardada aqui. Cada
 * invocação fria paga o boot do Nest — cerca de meio segundo — e uma instância
 * quente não paga nada. Construir por requisição multiplicaria isso por
 * chamada e ainda abriria um pool de conexões novo a cada vez.
 *
 * Guarda a promessa, e não a aplicação pronta: duas requisições que chegam
 * juntas na mesma instância fria encontram a mesma promessa em andamento e
 * esperam o mesmo boot, em vez de dispararem dois.
 */
let pending: Promise<NodeHandler> | null = null;

async function boot(): Promise<NodeHandler> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, new ExpressAdapter(), {
    // Sem o logger de boot: numa função, cada instância fria repetiria o mapa
    // de rotas inteiro no log, e o que interessa ali é erro.
    logger: ['error', 'warn'],
    /*
     * `abortOnError: false` é o que torna esta função DEPURÁVEL.
     *
     * No padrão, qualquer erro dentro do `create` faz o Nest chamar o teardown
     * dele, que é `process.exit(1)` — não uma promessa rejeitada, mas a morte
     * do processo. Numa função da Vercel isso vira FUNCTION_INVOCATION_FAILED
     * sem stack e sem corpo, e NENHUM try/catch em volta pega, porque não há
     * exceção a pegar: o processo simplesmente acabou. Foi o que escondeu,
     * durante toda a investigação, um erro que era só configuração faltando —
     * `DATABASE_URL` e as duas chaves do JWT, que o `loadConfig` recusa.
     *
     * Com `false`, o erro volta a ser uma rejeição normal, o handler abaixo
     * responde 503 com a causa, e a instância continua viva para a próxima
     * requisição.
     */
    abortOnError: false,
  });
  configureApp(app, app.get<AppConfig>(CONFIG));

  /*
   * `init()` e não `listen()`: quem escuta a porta é a Vercel. `listen()` aqui
   * subiria um segundo servidor que ninguém alcança, e a função ficaria
   * pendurada até estourar o tempo.
   *
   * `enableShutdownHooks` também fica de fora: não há SIGTERM para esperar, e
   * o gancho só acrescentaria trabalho ao encerramento de cada instância.
   */
  await app.init();
  return app.getHttpAdapter().getInstance() as NodeHandler;
}

function handler(req: IncomingMessage, res: ServerResponse): void {
  /*
   * O `.then` é encadeado na MESMA expressão que cria a promessa.
   *
   * Antes, `pending ??= boot().catch(…)` re-lançava de dentro do `catch`, e a
   * promessa rejeitada ficava guardada em `pending` sem tratador nenhum
   * naquele instante. Isso é uma unhandled rejection, e o Node derruba o
   * processo por causa dela — foi literalmente o que o log da função mostrava:
   * "Node.js process exited with exit status: 1". O processo morria antes de
   * escrever a resposta, então quem chamava via FUNCTION_INVOCATION_FAILED em
   * vez do erro, e nenhum tratamento aqui embaixo chegava a rodar.
   *
   * Guardando a promessa JÁ encadeada, toda rejeição nasce com tratador.
   */
  if (pending === null) {
    pending = boot();
    // Sem isto, uma falha de boot ficaria memorizada na promessa e TODA
    // requisição seguinte da instância falharia com o mesmo erro antigo, mesmo
    // depois de a causa passar.
    void pending.catch(() => {
      pending = null;
    });
  }

  void pending.then(
    (express) => express(req, res),
    (error: unknown) => {
      console.error('falha ao iniciar o serviço', error);

      /*
       * 503, e com a CAUSA no corpo.
       *
       * O que estava aqui era 500 com "Serviço indisponível." e nada mais.
       * Custou horas de investigação: sem `DATABASE_URL` e as duas chaves do
       * JWT, o serviço recusava subir — corretamente —, mas de fora isso era
       * indistinguível de bug de empacotamento, e a mensagem não dizia o que
       * faltava. Quem publica precisa ler a causa sem abrir o painel de logs.
       *
       * 503 e não 500 porque é exatamente isto: o serviço não subiu, e vai
       * subir assim que a configuração existir. 500 anuncia defeito.
       *
       * A mensagem do `loadConfig` lista os NOMES das variáveis que faltam, e
       * nunca o valor de nenhuma — devolver isso não vaza segredo.
       */
      const message =
        error instanceof Error ? error.message : 'O serviço não conseguiu iniciar.';
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: { code: 'service_unavailable', message } }));
    },
  );
}

export = handler;
