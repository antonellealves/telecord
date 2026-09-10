/**
 * Testes das peças de criptografia da autenticação.
 *
 * Rodam sem banco e sem rede de propósito: são as regras que, se quebrarem,
 * quebram calado — senha que valida à toa, token expirado que passa, refresh
 * cujo hash colide. Um teste que precisa de cluster não roda no CI e vira
 * decoração.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { hashPassword, verifyPassword } from '../src/auth/password';
import {
  generateRefreshToken,
  hashOpaqueToken,
  signAccessToken,
  verifyAccessToken,
} from '../src/auth/tokens';

function keys(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

describe('senha', () => {
  it('aceita a senha certa e recusa a errada', async () => {
    const stored = await hashPassword('cavalo-bateria-grampo');
    assert.equal(await verifyPassword('cavalo-bateria-grampo', stored), true);
    assert.equal(await verifyPassword('cavalo-bateria-grampa', stored), false);
  });

  it('nunca guarda a senha em claro', async () => {
    const stored = await hashPassword('senha-super-secreta');
    assert.equal(stored.includes('senha-super-secreta'), false);
    assert.equal(stored.startsWith('scrypt$'), true);
  });

  it('gera hash diferente para a mesma senha', async () => {
    // Sem sal por hash, duas contas com a mesma senha teriam a mesma linha no
    // banco — e quebrar uma quebraria as duas.
    const a = await hashPassword('mesma-senha-aqui');
    const b = await hashPassword('mesma-senha-aqui');
    assert.notEqual(a, b);
  });

  it('valida com os parâmetros guardados, não com os atuais', async () => {
    // Simula um hash antigo, criado com custo menor. Subir o custo depois não
    // pode invalidar a senha de quem já tinha conta.
    const legacy = await hashPassword('senha-antiga-valida');
    const [, , r, p, salt, hash] = legacy.split('$');
    const rewritten = ['scrypt', 16384, r, p, salt, hash].join('$');
    // Com N diferente do gravado, a derivação muda e a verificação falha —
    // é o que prova que o N usado vem da string, não da constante.
    assert.equal(await verifyPassword('senha-antiga-valida', rewritten), false);
    assert.equal(await verifyPassword('senha-antiga-valida', legacy), true);
  });

  it('recusa hash malformado sem estourar', async () => {
    for (const bad of ['', 'nada', 'scrypt$1$2', 'argon2$a$b$c$d$e']) {
      assert.equal(await verifyPassword('qualquer', bad), false);
    }
  });
});

describe('access token', () => {
  it('vai e volta com as claims', async () => {
    const { privateKey, publicKey } = keys();
    const token = await signAccessToken(privateKey, 900, {
      userId: 'user_1',
      role: 'ADMIN',
      displayName: 'Antonelle',
    });
    const claims = await verifyAccessToken(publicKey, token);
    assert.equal(claims.sub, 'user_1');
    assert.equal(claims.role, 'ADMIN');
    assert.equal(claims.name, 'Antonelle');
  });

  it('recusa token assinado por outra chave', async () => {
    // O ponto do par de chaves: quem só tem a pública valida, e nada mais.
    const mine = keys();
    const forged = keys();
    const token = await signAccessToken(forged.privateKey, 900, {
      userId: 'invasor',
      role: 'ADMIN',
      displayName: 'Invasor',
    });
    await assert.rejects(() => verifyAccessToken(mine.publicKey, token));
  });

  it('recusa token expirado', async () => {
    const { privateKey, publicKey } = keys();
    // TTL negativo nasce vencido, sem precisar esperar no teste.
    const token = await signAccessToken(privateKey, -10, {
      userId: 'user_1',
      role: 'USER',
      displayName: 'Alguém',
    });
    await assert.rejects(() => verifyAccessToken(publicKey, token));
  });

  it('recusa token adulterado', async () => {
    const { privateKey, publicKey } = keys();
    const token = await signAccessToken(privateKey, 900, {
      userId: 'user_1',
      role: 'USER',
      displayName: 'Alguém',
    });
    const [header, , signature] = token.split('.');
    const tampered = JSON.stringify({
      sub: 'user_1',
      role: 'ADMIN',
      name: 'Alguém',
      iss: 'telecord',
      aud: 'telecord-app',
      exp: Math.floor(Date.now() / 1000) + 900,
    });
    const swapped = `${header}.${Buffer.from(tampered).toString('base64url')}.${signature}`;
    await assert.rejects(() => verifyAccessToken(publicKey, swapped));
  });
});

describe('refresh token', () => {
  it('não se repete', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      seen.add(generateRefreshToken());
    }
    assert.equal(seen.size, 500);
  });

  it('guarda hash, e o hash não devolve o token', () => {
    const token = generateRefreshToken();
    const hash = hashOpaqueToken(token);
    assert.equal(hash.length, 64);
    assert.equal(hash.includes(token), false);
    assert.equal(hashOpaqueToken(token), hash);
    assert.notEqual(hashOpaqueToken(generateRefreshToken()), hash);
  });
});

after(() => {
  // scrypt com 64 MiB deixa o processo lento para encerrar sozinho no Windows.
  process.exitCode ??= 0;
});
