/**
 * Gera o par de chaves Ed25519 da autenticação e imprime no formato do .env.
 *
 *   node scripts/gen-auth-keys.mjs >> .env
 *
 * Par de chaves, e não segredo compartilhado, porque a função `/api/token` da
 * Vercel precisa VALIDAR o access token sem poder EMITIR um (PLANO.md §4.2).
 * Ela recebe só a pública.
 *
 * As quebras de linha do PEM viram `\n` literal: variável de ambiente de uma
 * linha só é o que Vercel, Fly e Railway aceitam sem cerimônia.
 */
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

const asEnv = (pem) => JSON.stringify(pem.trim()).slice(1, -1);

const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pub = publicKey.export({ type: 'spki', format: 'pem' });

console.log(`AUTH_JWT_PRIVATE_KEY="${asEnv(priv)}"`);
console.log(`AUTH_JWT_PUBLIC_KEY="${asEnv(pub)}"`);
