import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
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
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Sem o logger de boot: numa função, cada instância fria repetiria o mapa
    // de rotas inteiro no log, e o que interessa ali é erro.
    logger: ['error', 'warn'],
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
  pending ??= boot().catch((error: unknown) => {
    // Sem isto, uma falha de boot ficaria memorizada na promessa e TODA
    // requisição seguinte da instância falharia com o mesmo erro antigo, mesmo
    // depois de a causa passar.
    pending = null;
    throw error;
  });

  void pending.then(
    (express) => express(req, res),
    (error: unknown) => {
      console.error('falha ao iniciar o serviço', error);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: { code: 'internal', message: 'Serviço indisponível.' } }));
    },
  );
}

export = handler;
