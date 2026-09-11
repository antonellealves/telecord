/**
 * Empacota o serviço NestJS num arquivo só, para a função da Vercel.
 *
 * POR QUE ISTO EXISTE
 *
 * A Vercel compila cada arquivo de `api/` NUMA ETAPA SEPARADA, depois do
 * `buildCommand`, e essa etapa roda o próprio "Installing dependencies..." —
 * visível no log de build, logo antes do erro. Essa instalação não enxerga o
 * que o build do monorepo produziu: `packages/shared/dist` sai desatualizado
 * (daí o TS2339 em `api/token.ts`, reclamando de um `ValidationResult` que a
 * fonte já corrigiu) e `apps/api/dist` simplesmente não está lá.
 *
 * Ou seja: função em `api/` NÃO pode depender de saída de build do workspace.
 * Foi o que derrubou o catch-all em toda tentativa anterior — caminho
 * relativo, nome de pacote com `exports`, `node-linker=hoisted`: todas
 * dependiam de resolver algo que, naquele instante, não existe.
 *
 * A saída daqui é um `.cjs` sem nenhuma dependência externa a resolver, que a
 * função carrega por caminho relativo. O que ela importa está dentro dela.
 *
 * Ficam FORA do bundle (`external`) só os binários e o que o Prisma carrega
 * por caminho em tempo de execução: `.node` não é empacotável, e o cliente
 * gerado já mora em `apps/api/dist/src/generated/prisma`, copiado pelo build
 * do serviço e alcançado por caminho relativo a partir do bundle.
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('api/_bundle', { recursive: true });

await build({
  entryPoints: ['apps/api/dist/src/vercel.js'],
  outfile: 'api/_bundle/nest.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  // O Nest resolve dependência lendo metadado de decorator em tempo de
  // execução; minificar renomeia classe e quebra a resolução por tipo.
  minify: false,
  keepNames: true,
  external: [
    // Carregado por caminho relativo pelo próprio cliente gerado.
    '../generated/prisma',
    './generated/prisma',
    '*.node',
    // Opcionais do Nest que ele só exige se o recurso for usado. Sem isto o
    // esbuild falha ao não achar pacote que o projeto nem instalou.
    '@nestjs/microservices',
    '@nestjs/websockets',
    '@nestjs/platform-socket.io',
    'class-transformer',
    'class-validator',
    'cache-manager',
    '@fastify/*',
  ],
  logLevel: 'info',
});

console.log('bundle-api: api/_bundle/nest.cjs pronto');

/*
 * O cliente gerado do Prisma vai junto, ao lado do bundle.
 *
 * O `require("../generated/prisma")` que sobrou acima é relativo ao arquivo
 * empacotado (`api/_bundle/nest.cjs`), então o cliente precisa estar em
 * `api/generated/prisma`. Ele carrega o engine nativo por caminho, e binário
 * `.node` não entra em bundle — por isso é cópia, e não empacotamento.
 */
import { cpSync, rmSync } from 'node:fs';

rmSync('api/generated', { recursive: true, force: true });
cpSync('apps/api/src/generated', 'api/generated', { recursive: true });
console.log('bundle-api: cliente do Prisma copiado para api/generated');
