/**
 * Gera um par de credenciais para o LiveKit server local (mesmo formato do
 * LiveKit Cloud: uma api-key pública-ish e um secret).
 *
 *   node scripts/gen-livekit-keys.mjs >> .env
 *
 * As MESMAS duas variáveis já existem no projeto (LIVEKIT_API_KEY e
 * LIVEKIT_API_SECRET) — hoje elas autenticam contra o LiveKit Cloud; ao
 * apontar para o servidor local, viram a credencial DESTE servidor. Nada
 * muda do lado da API (api/token.ts, apps/api/src/livekit/webhook-auth.ts):
 * elas continuam emitindo e conferindo token do mesmo jeito.
 */
import { randomBytes } from 'node:crypto';

const base62 = (bytes) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
};

const apiKey = `API${base62(randomBytes(12))}`;
const apiSecret = base62(randomBytes(32));

console.log('# Para o .env (servidor LiveKit local em docker-compose.yml):\n');
console.log(`LIVEKIT_API_KEY=${apiKey}`);
console.log(`LIVEKIT_API_SECRET=${apiSecret}`);
console.log('\n# Aponte o front para o servidor local (opcional, já é o default no compose):');
console.log('# VITE_LIVEKIT_URL=ws://localhost:7880');
