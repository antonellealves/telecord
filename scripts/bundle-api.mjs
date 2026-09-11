/**
 * Empacota o serviço NestJS num arquivo só, para a função da Vercel.
 *
 * POR QUE ISTO EXISTE
 *
 * A Vercel compila cada arquivo de `api/` NUMA ETAPA SEPARADA, depois do
 * `buildCommand`, e essa etapa roda o próprio "Installing dependencies..." —
 * visível no log de build. Essa instalação não enxerga o que o build do
 * monorepo produziu: `apps/api/dist` não está lá, e `packages/shared/dist` é o
 * que veio do lockfile, não o recém-construído.
 *
 * Ou seja: função em `api/` NÃO pode depender de saída de build do workspace.
 * A saída daqui é um `.cjs` sem dependência externa, que a função carrega por
 * caminho relativo.
 *
 * A saída fica FORA de `api/`, em `api-bundle/`. Qualquer `.js`/`.cjs` dentro
 * de `api/` é candidato a virar função serverless própria no roteamento
 * zero-config da Vercel — e o cliente do Prisma sozinho traz mais de dez
 * arquivos `.js`, que viravam dez funções quebradas e atrapalhavam a captura.
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'api-bundle';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: ['apps/api/dist/src/vercel.js'],
  outfile: join(OUT, 'bundle', 'nest.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  // O Nest resolve dependência lendo metadado de decorator em tempo de
  // execução; minificar renomeia classe e quebra a resolução por tipo.
  minify: false,
  keepNames: true,
  external: [
    // Carregado por caminho relativo pelo cliente gerado, que fica ao lado.
    '../generated/prisma',
    '*.node',
    // Opcionais que o Nest só exige se o recurso for usado, e que este projeto
    // não instala. Sem isto o esbuild falha ao não encontrá-los.
    '@nestjs/microservices',
    '@nestjs/microservices/microservices-module',
    '@nestjs/websockets',
    '@nestjs/websockets/socket-module',
    'class-transformer',
    'class-validator',
    'cache-manager',
  ],
  logLevel: 'info',
});

/*
 * O cliente gerado do Prisma vai junto, ao lado do bundle: o
 * `require("../generated/prisma")` que sobra é relativo ao arquivo empacotado.
 * Ele carrega o engine nativo por caminho, e binário `.node` não entra em
 * bundle — por isso é cópia.
 */
cpSync('apps/api/src/generated', join(OUT, 'generated'), { recursive: true });

/*
 * O engine do Windows não serve para nada no runtime Linux da Vercel e são
 * 20MB no pacote da função, que tem teto. Fica só o `rhel-openssl-3.0.x`.
 */
const prismaDir = join(OUT, 'generated', 'prisma');
for (const f of readdirSync(prismaDir)) {
  if (f.includes('windows') || f.endsWith('.tmp')) {
    unlinkSync(join(prismaDir, f));
  }
}

console.log(`bundle-api: ${OUT}/bundle/nest.cjs e o cliente do Prisma prontos`);
