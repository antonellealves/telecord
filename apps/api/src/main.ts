import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { GLOBAL_PREFIX, configureApp } from './bootstrap';
import { CONFIG, type AppConfig } from './common/config';

/**
 * Entrada do serviço quando ele roda como processo próprio.
 *
 * É o modo do desenvolvimento local (docker-compose). Em produção quem manda é
 * `vercel.ts`, e as duas compartilham `configureApp` para não divergirem.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const config = app.get<AppConfig>(CONFIG);

  configureApp(app, config);

  // Faz o `onModuleDestroy` do Prisma rodar no SIGTERM do orquestrador; sem
  // isso o pool fica pendurado a cada reinício do contêiner.
  app.enableShutdownHooks();

  await app.listen(config.port, '0.0.0.0');
  new Logger('bootstrap').log(
    `API em :${config.port}/${GLOBAL_PREFIX} — app ${config.appUrl}, ` +
      `google ${config.google === null ? 'desligado' : 'ligado'}, e-mail via ${config.mailDriver}`,
  );
}

void bootstrap();
