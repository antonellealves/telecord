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

/*
 * Duas formas, separadas e rotuladas.
 *
 * A de cima tem aspas porque é linha de arquivo `.env`, onde elas são
 * delimitador do shell. A de baixo NÃO tem, porque num campo de painel
 * (Vercel, GitHub, Railway) a aspa vira parte do valor — e aí o PEM é
 * recusado com "must be PKCS#8 formatted string", que não fala em aspas.
 *
 * Isto não é hipótese: foi exatamente o que aconteceu em produção. E o modo de
 * falha é traiçoeiro, porque a chave só é usada ao ASSINAR — o serviço sobe,
 * as telas carregam, o login com senha errada responde 401 corretamente, e só
 * cadastrar ou entrar de verdade quebra com 500.
 *
 * O serviço passa a tolerar as aspas de qualquer forma, mas quem gera a chave
 * merece ver o valor certo para cada destino em vez de descobrir depois.
 */
console.log('# Para um arquivo .env (as aspas fazem parte da sintaxe):\n');
console.log(`AUTH_JWT_PRIVATE_KEY="${asEnv(priv)}"`);
console.log(`AUTH_JWT_PUBLIC_KEY="${asEnv(pub)}"`);

console.log('\n# Para colar em painel (Vercel, GitHub secrets) — SEM as aspas:\n');
console.log(`AUTH_JWT_PRIVATE_KEY:\n${asEnv(priv)}\n`);
console.log(`AUTH_JWT_PUBLIC_KEY:\n${asEnv(pub)}`);
