/**
 * A chave do JWT tem que sobreviver ao caminho do copiar-e-colar.
 *
 * Isto existe por causa de uma falha real em produção. `gen-auth-keys.mjs`
 * imprime a chave no formato de arquivo `.env` — `AUTH_JWT_PRIVATE_KEY="-----
 * BEGIN…"` — e as aspas, que ali são sintaxe do shell, viraram parte do valor
 * ao serem coladas num campo de painel da Vercel.
 *
 * O modo de falha foi cruel justamente por ser parcial: a chave só é tocada ao
 * ASSINAR, então o serviço subia, as telas carregavam e o login com senha
 * errada respondia 401 certinho. Só cadastrar e entrar de verdade quebravam
 * com 500 — os dois únicos caminhos que chegam em `signAccessToken`.
 *
 * Roda sem banco e sem rede, como o resto da pasta.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/common/config';
import { signAccessToken, verifyAccessToken } from '../src/auth/tokens';

function pemPair(): { priv: string; pub: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim(),
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString().trim(),
  };
}

/** Uma linha só, com `\n` escapado — como painel de nuvem guarda. */
function umaLinha(pem: string): string {
  return pem.replace(/\n/g, '\\n');
}

function envBase(priv: string, pub: string): NodeJS.ProcessEnv {
  return {
    APP_URL: 'https://telecord.example',
    API_URL: 'https://telecord.example/api',
    DATABASE_URL: 'mysql://u:p@127.0.0.1:4000/t',
    AUTH_JWT_PRIVATE_KEY: priv,
    AUTH_JWT_PUBLIC_KEY: pub,
  };
}

describe('PEM vindo do ambiente', () => {
  it('aceita a chave com `\\n` escapado', () => {
    const { priv, pub } = pemPair();
    const config = loadConfig(envBase(umaLinha(priv), umaLinha(pub)));
    assert.ok(config.jwtPrivateKey.includes('\n'), 'o `\\n` escapado vira quebra real');
    assert.ok(config.jwtPrivateKey.startsWith('-----BEGIN'));
  });

  it('tira as aspas duplas que o painel guarda junto', () => {
    const { priv, pub } = pemPair();
    const config = loadConfig(envBase(`"${umaLinha(priv)}"`, `"${umaLinha(pub)}"`));
    assert.ok(
      config.jwtPrivateKey.startsWith('-----BEGIN'),
      'a aspa não pode sobrar no começo do PEM',
    );
    assert.ok(config.jwtPrivateKey.trim().endsWith('-----'), 'nem no fim');
  });

  it('tira aspas simples também', () => {
    const { priv, pub } = pemPair();
    const config = loadConfig(envBase(`'${umaLinha(priv)}'`, `'${umaLinha(pub)}'`));
    assert.ok(config.jwtPrivateKey.startsWith('-----BEGIN'));
  });

  /*
   * O teste que teria pego o bug: não basta o PEM PARECER certo, ele tem que
   * assinar. Era exatamente aqui que produção quebrava.
   */
  it('a chave com aspas ainda assina e valida um access token', async () => {
    const { priv, pub } = pemPair();
    const config = loadConfig(envBase(`"${umaLinha(priv)}"`, `"${umaLinha(pub)}"`));

    const token = await signAccessToken(config.jwtPrivateKey, 60, {
      userId: 'u1',
      role: 'USER',
      displayName: 'Fulana',
    });
    const claims = await verifyAccessToken(config.jwtPublicKey, token);
    // O token guarda as claims padrão do JWT: `sub` e `name`, não os nomes
    // internos que `signAccessToken` recebe.
    assert.equal(claims.sub, 'u1');
    assert.equal(claims.name, 'Fulana');
    assert.equal(claims.role, 'USER');
  });
});
