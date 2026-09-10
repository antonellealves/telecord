/**
 * MODELO de seed. Este arquivo é versionado; o seed de verdade NÃO é.
 *
 *   cp apps/api/prisma/seed.sample.mjs apps/api/prisma/seed.mjs
 *   # edite o bloco DADOS abaixo
 *   pnpm --filter @telecord/api build         # o seed usa o hash compilado
 *   DATABASE_URL="mysql://…" pnpm --filter @telecord/api prisma:seed
 *
 * `seed.mjs` está no `.gitignore` pelo mesmo motivo do `.env`: ele carrega o
 * e-mail e a SENHA da primeira conta administradora. Um seed com credencial
 * dentro, versionado, é uma senha de administrador publicada — e num
 * repositório ela nunca mais sai do histórico.
 *
 * O modelo fica versionado para que a FORMA do seed continue revisável: quem
 * abrir o repo daqui a seis meses vê o que ele cria e por quê, sem ver os
 * valores de ninguém.
 *
 * ## Por que `.mjs` e não `.ts`
 *
 * Para não entrar no `tsconfig` do serviço. O seed roda de vez em quando, à
 * mão, e não faz parte do que é compilado e publicado — arrastá-lo para o
 * build significaria que um seed quebrado quebra o deploy.
 *
 * ## Por que ele exige o build
 *
 * O hash de senha vem de `dist/src/auth/password.js`, o MESMO módulo que o
 * login usa. Reimplementar scrypt aqui seria criar um segundo lugar onde o
 * formato do hash pode divergir — e o sintoma seria a conta semeada não
 * conseguir entrar, sem ninguém entender por quê.
 *
 * ## Idempotente
 *
 * Tudo por `upsert`. Rodar duas vezes não cria duas contas nem estoura em
 * `unique`; a segunda passagem só atualiza. É o que permite rodar o seed
 * depois de uma migração sem pensar duas vezes.
 */
import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// DADOS — é isto que você edita na sua cópia.
// ---------------------------------------------------------------------------

const ADMIN = {
  email: 'voce@exemplo.com',
  displayName: 'Seu nome',
  username: 'voce',
  /*
   * Mínimo de 10 caracteres (a regra está em `@telecord/shared`). Comprimento
   * é a única regra que aumenta de verdade o custo de quebrar — exigir
   * maiúscula e símbolo produz `Senha@123`, que está no topo de qualquer
   * dicionário.
   */
  password: 'troque-esta-senha-antes-de-rodar',
};

/** Salas criadas junto, já com o admin como dono. Deixe `[]` para nenhuma. */
const ROOMS = [
  {
    slug: 'geral',
    name: 'Geral',
    description: 'Sala de sempre.',
    emoji: '🎧',
    visibility: 'PUBLIC',
  },
];

// ---------------------------------------------------------------------------

const prisma = new PrismaClient();

function loadHashPassword() {
  try {
    // Caminho relativo a este arquivo: prisma/ → ../dist/src/auth/password.js
    return require('../dist/src/auth/password.js').hashPassword;
  } catch {
    throw new Error(
      'dist/src/auth/password.js não existe. Rode `pnpm --filter @telecord/api build` antes do seed.',
    );
  }
}

async function main() {
  if (ADMIN.password === 'troque-esta-senha-antes-de-rodar') {
    throw new Error('Edite o bloco DADOS antes de rodar: a senha ainda é a do modelo.');
  }

  const hashPassword = loadHashPassword();
  const passwordHash = await hashPassword(ADMIN.password);
  const email = ADMIN.email.trim().toLowerCase();

  /*
   * `emailVerifiedAt` preenchido de propósito.
   *
   * É o que destrava a vinculação com o Google depois (PLANO.md §3): conta com
   * e-mail não confirmado nunca é adotada por um login social. Aqui a posse do
   * endereço não está em dúvida — quem roda o seed é dono do banco.
   */
  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      username: ADMIN.username,
      displayName: ADMIN.displayName,
      passwordHash,
      role: 'ADMIN',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
    update: {
      passwordHash,
      role: 'ADMIN',
      status: 'ACTIVE',
      deletedAt: null,
      emailVerifiedAt: new Date(),
    },
  });

  // Settings nunca pode ser nulo — é a mesma garantia que o cadastro dá.
  await prisma.userSettings.upsert({
    where: { userId: user.id },
    create: { userId: user.id },
    update: {},
  });

  for (const room of ROOMS) {
    const created = await prisma.room.upsert({
      where: { slug: room.slug },
      create: { ...room, ownerId: user.id },
      update: { ...room, ownerId: user.id, deletedAt: null },
    });
    await prisma.roomMember.upsert({
      where: { roomId_userId: { roomId: created.id, userId: user.id } },
      create: { roomId: created.id, userId: user.id, role: 'OWNER' },
      update: { role: 'OWNER' },
    });
  }

  // Nunca imprime a senha: o log do terminal sobrevive à sessão, e o valor já
  // está no arquivo de quem rodou.
  console.log(`admin: ${user.email} (${user.role})`);
  console.log(`salas: ${ROOMS.map((room) => room.slug).join(', ') || 'nenhuma'}`);
}

main()
  .catch((error) => {
    console.error('seed falhou:', error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
