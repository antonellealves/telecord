import { createHash, timingSafeEqual } from 'node:crypto';
import { jwtVerify } from 'jose';

/**
 * Verificação da assinatura do webhook do LiveKit.
 *
 * Escrita à mão, com `jose` e `node:crypto`, em vez de trazer o
 * `livekit-server-sdk` para dentro do serviço. Três razões, em ordem de peso:
 *
 * 1. **Dá para testar.** Como função pura sobre (cabeçalho, corpo, credencial),
 *    cada caso — assinatura de outra chave, corpo trocado depois de assinado,
 *    token vencido — vira um teste de três linhas, sem rede e sem LiveKit. É a
 *    única barreira entre o mundo e a tabela que alimenta o painel: se ela
 *    ceder, qualquer um inventa horas de conversa que nunca aconteceram.
 * 2. O SDK é publicado como ESM e este serviço compila para CommonJS. Dá para
 *    contornar, mas o contorno vira mais uma coisa que quebra no deploy.
 * 3. O protocolo é pequeno o bastante para caber aqui e ficar legível.
 *
 * ## O protocolo
 *
 * O LiveKit manda o corpo em JSON e, no cabeçalho `Authorization`, um JWT
 * HS256 assinado com o *API secret* do projeto. Dentro dele:
 *
 *   - `iss`: a *API key*, que diz qual projeto assinou;
 *   - `sha256`: o SHA-256 do CORPO, em base64.
 *
 * O segundo campo é o que amarra a assinatura àquele corpo específico. Sem
 * conferi-lo, um JWT capturado de um webhook legítimo poderia ser reapresentado
 * com qualquer conteúdo — a assinatura continuaria válida, porque ela não
 * cobre o corpo diretamente.
 *
 * Daí a insistência do `raw-body.ts` em bytes crus: o hash é sobre os bytes que
 * chegaram, e reserializar o JSON muda um espaço e derruba a conferência.
 */

export type WebhookCheck =
  | { ok: true; event: LiveKitWebhookEvent }
  | { ok: false; reason: string };

export interface LiveKitWebhookEvent {
  /** Único por entrega. É o que impede a mesma entrada de virar duas. */
  id: string | null;
  event: string;
  roomName: string | null;
  participantIdentity: string | null;
  participantName: string | null;
  /** Epoch em milissegundos, já normalizado. */
  createdAt: number;
}

export async function verifyLiveKitWebhook(input: {
  authorization: string | undefined;
  body: Buffer;
  apiKey: string;
  apiSecret: string;
}): Promise<WebhookCheck> {
  const token = (input.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (token === '') {
    return { ok: false, reason: 'sem cabeçalho de autorização' };
  }

  let claims: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, new TextEncoder().encode(input.apiSecret), {
      // Sem fixar o algoritmo, um token com `alg: none` passaria — e o
      // atacante nem precisaria do segredo.
      algorithms: ['HS256'],
      issuer: input.apiKey,
    });
    claims = verified.payload as Record<string, unknown>;
  } catch (failure) {
    return { ok: false, reason: `assinatura inválida (${describe(failure)})` };
  }

  const declared = claims.sha256;
  if (typeof declared !== 'string' || declared === '') {
    return { ok: false, reason: 'token sem o hash do corpo' };
  }

  const actual = createHash('sha256').update(input.body).digest();
  let expected: Buffer;
  try {
    expected = Buffer.from(declared, 'base64');
  } catch {
    return { ok: false, reason: 'hash do corpo malformado' };
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'o corpo não é o que foi assinado' };
  }

  const parsed = parseEvent(input.body);
  if (parsed === null) {
    return { ok: false, reason: 'corpo não é um evento reconhecível' };
  }
  return { ok: true, event: parsed };
}

/**
 * Leitura defensiva do corpo.
 *
 * A assinatura já provou a origem, mas o formato ainda pode mudar entre
 * versões do LiveKit, e um campo ausente não pode virar exceção no meio de uma
 * gravação — o webhook seria reentregue em laço.
 */
function parseEvent(body: Buffer): LiveKitWebhookEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;

  const value = raw as {
    id?: unknown;
    event?: unknown;
    createdAt?: unknown;
    room?: { name?: unknown } | null;
    participant?: { identity?: unknown; name?: unknown } | null;
  };

  if (typeof value.event !== 'string' || value.event === '') return null;

  return {
    id: typeof value.id === 'string' && value.id !== '' ? value.id.slice(0, 64) : null,
    event: value.event,
    roomName: readText(value.room?.name, 64),
    participantIdentity: readText(value.participant?.identity, 64),
    participantName: readText(value.participant?.name, 64),
    createdAt: readTimestamp(value.createdAt),
  };
}

function readText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value !== '' ? value.slice(0, max) : null;
}

/**
 * O `createdAt` do LiveKit vem em SEGUNDOS, e às vezes como string (o campo é
 * `int64` no protobuf, que o JSON serializa entre aspas para não perder
 * precisão). Tratar como milissegundos jogaria todo evento para 1970 — e a
 * série do painel ficaria vazia sem ninguém entender por quê.
 */
function readTimestamp(value: unknown): number {
  const seconds = typeof value === 'string' ? Number(value) : value;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return Date.now();
  }
  return Math.round(seconds * 1000);
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
