import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, importPKCS8, importSPKI, jwtVerify, type JWTPayload } from 'jose';

/**
 * EdDSA (Ed25519), não HS256.
 *
 * Com segredo simétrico, todo serviço que precisa VALIDAR um token também
 * consegue EMITIR um. A função `/api/token` da Vercel valida o access token
 * para saber quem está entrando na sala; com HS256 ela teria a chave de
 * assinatura, e um vazamento lá viraria emissão de sessão para qualquer
 * identidade. Com par de chaves ela só recebe a pública.
 */
const ALG = 'EdDSA';
const ISSUER = 'telecord';
const AUDIENCE = 'telecord-app';

export interface AccessClaims extends JWTPayload {
  sub: string;
  role: string;
  name: string;
}

export async function signAccessToken(
  privateKeyPem: string,
  ttlSeconds: number,
  claims: { userId: string; role: string; displayName: string },
): Promise<string> {
  const key = await importPKCS8(privateKeyPem, ALG);
  return new SignJWT({ role: claims.role, name: claims.displayName })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key);
}

export async function verifyAccessToken(
  publicKeyPem: string,
  token: string,
): Promise<AccessClaims> {
  const key = await importSPKI(publicKeyPem, ALG);
  const { payload } = await jwtVerify(token, key, {
    issuer: ISSUER,
    audience: AUDIENCE,
    // Sem isto, um token assinado com `alg: none` ou com outro algoritmo
    // passaria pela verificação.
    algorithms: [ALG],
  });
  const { sub, role, name } = payload;
  if (typeof sub !== 'string' || typeof role !== 'string' || typeof name !== 'string') {
    throw new Error('claims incompletas');
  }
  return { ...payload, sub, role, name };
}

/*
 * O refresh é opaco, não JWT: ele precisa ser revogável, e JWT só é revogável
 * com uma lista no banco — que é exatamente a consulta que o token opaco já
 * faz, sem a criptografia no meio.
 */
const REFRESH_BYTES = 32;

export function generateRefreshToken(): string {
  return randomBytes(REFRESH_BYTES).toString('base64url');
}

/**
 * SHA-256 sem sal, de propósito: o valor já é 256 bits aleatórios, não tem
 * dicionário para atacar, e sal impediria a busca por índice — que é o ponto
 * de guardar o hash.
 */
export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
