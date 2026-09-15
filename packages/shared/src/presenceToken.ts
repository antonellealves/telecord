/**
 * Token de presença de curta duração para o canal Socket.IO do mediasoup-sfu.
 *
 * HMAC manual em vez de JWT: o processo mediasoup-sfu já autentica
 * `apps/api` com um Bearer simples comparado por tempo constante (ver
 * `apps/mediasoup-sfu/src/http.ts`) — este token reusa o MESMO segredo
 * (`MEDIASOUP_INTERNAL_SECRET`) e o mesmo espírito, só que assinado por
 * `apps/api` e verificado sem I/O pelo mediasoup-sfu (sem bater no Prisma de
 * novo), o que é o que permite o processo validar a conexão sozinho.
 *
 * `crypto.subtle` (Web Crypto) em vez de `node:crypto`: este pacote é
 * universal (`types: []` no `tsconfig.json`, sem dependência de Node) e
 * `crypto.subtle` existe tanto no Node (desde a v19, global) quanto no
 * navegador — não precisa de `Buffer` nem de um `@types/node` novo aqui.
 *
 * Vida curta de propósito: o token só precisa sobreviver do momento em que
 * `apps/api` o assina até o handshake do socket completar no navegador —
 * segundos, não minutos. Isso reduz a janela de replay caso o token vaze (ex.
 * num log de rede) sem exigir revogação.
 */

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeText(value: string): string {
  return base64UrlEncode(new TextEncoder().encode(value));
}

function base64UrlDecodeText(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return bytesToHex(new Uint8Array(signature));
}

/** Comparação em tempo constante — evita vazar, por timing, quantos bytes iniciais batem. */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface PresenceTokenClaims {
  peerId: string;
  roomSlug: string;
  displayName: string;
}

export interface SignPresenceTokenInput extends PresenceTokenClaims {
  secret: string;
  /** Tempo de vida do token, em milissegundos. */
  ttlMs: number;
}

/** Assina um token de peer normal — só `apps/api` chama isto, depois de `assertMember` já ter aprovado a entrada na sala. */
export async function signPresenceToken(input: SignPresenceTokenInput): Promise<string> {
  const exp = Math.floor((Date.now() + input.ttlMs) / 1000);
  const nameB64 = base64UrlEncodeText(input.displayName);
  const payload = `${input.peerId}.${input.roomSlug}.${nameB64}.${exp}`;
  const signature = await hmacHex(input.secret, payload);
  return `${payload}.${signature}`;
}

/** Verifica um token de peer — chamado pelo mediasoup-sfu ao aceitar uma conexão Socket.IO. Sem I/O: só recalcula o HMAC. */
export async function verifyPresenceToken(token: string, secret: string): Promise<PresenceTokenClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [peerId, roomSlug, nameB64, expRaw, signature] = parts as [string, string, string, string, string];

  const payload = `${peerId}.${roomSlug}.${nameB64}.${expRaw}`;
  const expected = await hmacHex(secret, payload);
  if (!safeEqualHex(signature, expected)) return null;

  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  if (peerId === '' || roomSlug === '') return null;

  let displayName: string;
  try {
    displayName = base64UrlDecodeText(nameB64);
  } catch {
    return null;
  }

  return { peerId, roomSlug, displayName };
}

export interface AdminPresenceTokenClaims {
  actorId: string;
}

export interface SignAdminPresenceTokenInput extends AdminPresenceTokenClaims {
  secret: string;
  ttlMs: number;
}

/** Assina um token de admin — sem `roomSlug` fixo, porque o painel troca de sala sem pedir token novo. */
export async function signAdminPresenceToken(input: SignAdminPresenceTokenInput): Promise<string> {
  const exp = Math.floor((Date.now() + input.ttlMs) / 1000);
  const payload = `admin.${input.actorId}.${exp}`;
  const signature = await hmacHex(input.secret, payload);
  return `${payload}.${signature}`;
}

/** Verifica um token de admin — reconhecido pelo prefixo `admin.` antes de tentar como token de peer. */
export async function verifyAdminPresenceToken(token: string, secret: string): Promise<AdminPresenceTokenClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'admin') return null;
  const [, actorId, expRaw, signature] = parts as [string, string, string, string];

  const payload = `admin.${actorId}.${expRaw}`;
  const expected = await hmacHex(secret, payload);
  if (!safeEqualHex(signature, expected)) return null;

  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  if (actorId === '') return null;

  return { actorId };
}
