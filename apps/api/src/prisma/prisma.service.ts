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
  /**
   * Conecta sem poder derrubar o boot.
   *
   * `$connect()` lançando aqui aborta a criação do módulo inteiro, e numa
   * função da Vercel isso significa que TODA rota passa a responder 500 —
   * inclusive as que não tocam o banco, e inclusive `/api/nada`, que deveria
   * ser 404. Um banco momentaneamente fora do ar virava app inteiro fora do
   * ar, e o sintoma (`FUNCTION_INVOCATION_FAILED`) não dizia qual era a causa.
   *
   * O Prisma reconecta sozinho na primeira consulta, então perder esta
   * conexão adiantada não custa correção nenhuma: custa a latência de abrir o
   * pool na primeira consulta em vez de no boot. Quem depende do banco falha
   * na própria rota, com o erro da própria rota; quem não depende segue
   * respondendo.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch (error) {
      console.error('Prisma: conexão inicial falhou; seguirá por consulta.', error);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
