import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Cliente do Prisma com o ciclo de vida amarrado ao do Nest.
 *
 * Um processo, um pool — que é a única coisa que a escolha de NestJS em vez de
 * serverless simplifica de verdade (PLANO.md §2.3). O teto de conexões vem da
 * própria `DATABASE_URL` (`connection_limit`), porque é lá que o TiDB Starter
 * impõe o limite dele.
 *
 * `$disconnect` no destroy importa: sem ele, um reload em desenvolvimento
 * deixa o pool anterior pendurado e a segunda ou terceira reinicialização bate
 * no teto de conexões do cluster.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
