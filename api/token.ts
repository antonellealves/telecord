/**
 * POST /api/token — emissão do JWT de acesso ao LiveKit (SPEC §2).
 *
 * Handler Node da Vercel. Síncrono do ponto de vista de I/O: valida a entrada,
 * assina o token com HS256 e responde. Sem rede, sem disco, sem estado.
 *
 * Tipado com `node:http` em vez de `@vercel/node` para não adicionar
 * dependência fora da lista permitida — a assinatura é compatível com o
 * runtime Node da Vercel e com o middleware do Vite usado em dev.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import {
  MAX_TOKEN_REQUEST_BYTES,
  TOKEN_TTL_SECONDS,
  validateTokenRequest,
  type TokenErrorCode,
  type TokenErrorResponse,
  type TokenSuccessResponse,
} from '@telecord/shared';

/**
 * O runtime da Vercel pode já ter consumido o stream e deixado o corpo em
 * `req.body`; o middleware do Vite, não. O handler cobre os dois casos.
 */
type RequestWithBody = IncomingMessage & { body?: unknown };

class BodyTooLargeError extends Error {}
class InvalidJsonError extends Error {}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function sendError(
  res: ServerResponse,
  status: number,
  code: TokenErrorCode,
  message: string,
): void {
  const body: TokenErrorResponse = { error: { code, message } };
  sendJson(res, status, body);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new InvalidJsonError();
  }
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    size += buffer.byteLength;
    if (size > MAX_TOKEN_REQUEST_BYTES) {
      throw new BodyTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function resolveBody(req: RequestWithBody): Promise<unknown> {
  const preParsed = req.body;
  if (preParsed !== undefined && preParsed !== null) {
    if (typeof preParsed === 'string') {
      return preParsed.trim() === '' ? undefined : parseJson(preParsed);
    }
    if (Buffer.isBuffer(preParsed)) {
      const raw = preParsed.toString('utf8');
      return raw.trim() === '' ? undefined : parseJson(raw);
    }
    return preParsed;
  }

  const raw = await readRawBody(req);
  return raw.trim() === '' ? undefined : parseJson(raw);
}

/** Log estruturado. Nunca inclui key, secret, token ou corpo cru (SPEC §2.2). */
function log(fields: Record<string, string | number>): void {
  console.log(JSON.stringify({ scope: 'api/token', ...fields }));
}

export default async function handler(
  req: RequestWithBody,
  res: ServerResponse,
): Promise<void> {
  const startedAt = Date.now();

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST.');
    return;
  }

  const declaredLength = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TOKEN_REQUEST_BYTES) {
    sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Corpo grande demais.');
    return;
  }

  let body: unknown;
  try {
    body = await resolveBody(req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Corpo grande demais.');
      return;
    }
    sendError(res, 400, 'INVALID_JSON', 'O corpo precisa ser um objeto JSON válido.');
    return;
  }

  const validation = validateTokenRequest(body);
  if (!validation.ok) {
    sendError(res, 400, validation.code, validation.message);
    return;
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const missing: string[] = [];
  if (!apiKey) missing.push('LIVEKIT_API_KEY');
  if (!apiSecret) missing.push('LIVEKIT_API_SECRET');
  if (!apiKey || !apiSecret) {
    // Diz QUAL variável falta — nunca o valor de nenhuma.
    log({ code: 'SERVER_MISCONFIGURED', missing: missing.join(',') });
    sendError(
      res,
      500,
      'SERVER_MISCONFIGURED',
      `Servidor sem credenciais do LiveKit. Configure ${missing.join(' e ')} no ambiente.`,
    );
    return;
  }

  const { roomId, displayName } = validation.value;
  const identity = randomUUID();

  try {
    const accessToken = new AccessToken(apiKey, apiSecret, {
      identity,
      name: displayName,
      ttl: TOKEN_TTL_SECONDS,
    });

    accessToken.addGrant({
      roomJoin: true,
      room: roomId,
      canSubscribe: true,
      canPublish: true,
      // Câmera fica de fora: é a única restrição de mídia imposta pelo
      // servidor (SPEC §2.2).
      canPublishSources: [
        TrackSource.MICROPHONE,
        TrackSource.SCREEN_SHARE,
        TrackSource.SCREEN_SHARE_AUDIO,
      ],
      // Chat e soundboard passam pelo canal de dados. Sem isto o servidor
      // recusa qualquer publishData.
      canPublishData: true,
      canUpdateOwnMetadata: false,
      roomCreate: false,
      roomAdmin: false,
      hidden: false,
      recorder: false,
    });

    const token = await accessToken.toJwt();

    const payload: TokenSuccessResponse = {
      token,
      identity,
      roomId,
      displayName,
      expiresInSeconds: TOKEN_TTL_SECONDS,
    };

    log({ code: 'OK', roomId, identity, durationMs: Date.now() - startedAt });
    sendJson(res, 200, payload);
  } catch {
    // O erro original não é logado: pode carregar material da assinatura.
    log({ code: 'TOKEN_SIGN_FAILED', roomId, identity, durationMs: Date.now() - startedAt });
    sendError(res, 500, 'TOKEN_SIGN_FAILED', 'Não foi possível emitir o token.');
  }
}
