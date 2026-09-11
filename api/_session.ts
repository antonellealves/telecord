/**
 * Leitura da sessão do telecord dentro das funções da Vercel.
 *
 * Só VALIDA — nunca emite. A chave privada mora no serviço de autenticação
 * (`apps/api`); aqui entra apenas a pública, então um vazamento neste lado não
 * permite forjar identidade nenhuma (PLANO.md §4.2).
 *
 * O prefixo `_` mantém o arquivo fora do roteamento da Vercel: `api/_session.ts`
 * não vira endpoint.
 */
import type { IncomingMessage } from 'node:http';
import { importSPKI, jwtVerify } from 'jose';

const ALG = 'EdDSA';
const ISSUER = 'telecord';
const AUDIENCE = 'telecord-app';

export interface SessionClaims {
  userId: string;
  role: string;
  displayName: string;
}

/**
 * Devolve a sessão, ou `null` para qualquer falha.
 *
 * Falha aqui NÃO é erro de requisição: entrar sem conta continua sendo o
 * caminho normal do produto (PLANO.md §0). Token ausente, expirado ou inválido
 * apenas faz a pessoa entrar como anônima, exatamente como antes de existir
 * autenticação.
 */
export async function readSession(req: IncomingMessage): Promise<SessionClaims | null> {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) {
    return null;
  }

  const publicKey = process.env.AUTH_JWT_PUBLIC_KEY;
  if (!publicKey) {
    // Sem chave configurada o app inteiro segue anônimo, que é o estado
    // anterior à autenticação — e não uma falha que impeça entrar na sala.
    return null;
  }

  try {
    /*
     * Desfaz o `\n` LITERAL do PEM.
     *
     * A Vercel guarda variável de ambiente numa linha só, então a chave chega
     * com a barra-n escrita em vez de quebra de linha, e o `jose` recusa PEM
     * assim. O mesmo tratamento existe em `apps/api/src/common/config.ts`.
     *
     * A expressão precisa ser `/\\n/g` — barra invertida seguida de "n". Com
     * `/\n/g` ela casaria com a quebra de linha de verdade e trocaria uma
     * quebra por outra igual: uma operação sem efeito nenhum, que deixaria a
     * chave inutilizável e faria TODO mundo entrar na sala como anônimo, sem
     * erro visível em lugar nenhum — porque falha aqui é, por desenho,
     * indistinguível de "não mandou token".
     */
    /*
     * Tira as aspas de fora, além do `\n` escapado — mesmo tratamento de
     * `apps/api/src/common/config.ts`, e pelo mesmo motivo: colar no painel o
     * valor que `gen-auth-keys.mjs` imprime (`CHAVE="-----BEGIN…"`) leva as
     * aspas do shell junto, e aí o PEM é recusado. Aqui a falha é SILENCIOSA
     * por desenho — token inválido só faz a pessoa entrar como anônima —, o
     * que torna a aspa perdida ainda mais difícil de achar.
     */
    const pem = publicKey
      .trim()
      .replace(/^(['"])([\s\S]*)\1$/, '$2')
      .replace(/\\n/g, '\n');
    const key = await importSPKI(pem, ALG);
    const { payload } = await jwtVerify(header.slice(7), key, {
      issuer: ISSUER,
      audience: AUDIENCE,
      // Sem fixar o algoritmo, um token com `alg: none` passaria.
      algorithms: [ALG],
    });
    const { sub, role, name } = payload;
    if (typeof sub !== 'string' || typeof role !== 'string' || typeof name !== 'string') {
      return null;
    }
    return { userId: sub, role, displayName: name };
  } catch {
    return null;
  }
}
