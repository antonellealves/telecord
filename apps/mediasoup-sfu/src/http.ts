import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type {
  MediasoupConnectTransportBody,
  MediasoupConsumeBody,
  MediasoupConsumeResult,
  MediasoupCreateTransportBody,
  MediasoupProduceBody,
  MediasoupProduceResult,
  MediasoupTransportInfo,
} from '@telecord/shared';
import { BadRequestError, NotFoundError, RoomRegistry } from './rooms';

const MAX_BODY_BYTES = 256 * 1024;

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'corpo grande demais');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'corpo não é JSON válido');
  }
}

function transportInfo(transport: {
  id: string;
  iceParameters: unknown;
  iceCandidates: unknown;
  dtlsParameters: unknown;
}): MediasoupTransportInfo {
  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new HttpError(400, `campo '${field}' ausente ou inválido`);
  }
  return value;
}

/**
 * Servidor HTTP interno do mediasoup-sfu.
 *
 * NUNCA exposto ao navegador — só `apps/api` fala com ele (ver
 * `apps/api/src/mediasoup/mediasoup.service.ts`), autenticado por segredo
 * compartilhado. Espelha em forma o `CloudflareRealtimeClient`: aqui é este
 * processo quem faz o papel da API da Cloudflare, só que como serviço nosso
 * na VM em vez de terceiro.
 *
 * Sem framework (Express/Nest): é um processo pequeno, de responsabilidade
 * única, e a lista de rotas cabe inteira nesta função sem perder legibilidade.
 */
export function startHttpServer(
  port: number,
  internalSecret: string,
  registry: RoomRegistry,
): void {
  const server = createServer((req, res) => {
    void handle(req, res, internalSecret, registry).catch((error) => {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      if (error instanceof NotFoundError) {
        sendJson(res, 404, { error: error.message });
        return;
      }
      if (error instanceof BadRequestError) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ scope: 'mediasoup-sfu', event: 'unhandled', message: String(error) }));
      sendJson(res, 500, { error: 'erro interno' });
    });
  });
  server.listen(port);
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  internalSecret: string,
  registry: RoomRegistry,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://internal');
  const path = url.pathname;

  // Health check não exige segredo: é o que o docker-compose/CI usa para
  // saber se o processo subiu, e não carrega informação de sala nenhuma.
  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const authorization = req.headers.authorization ?? '';
  const token = authorization.replace(/^Bearer\s+/i, '');
  const expected = Buffer.from(internalSecret);
  const actual = Buffer.from(token);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    sendJson(res, 401, { error: 'segredo interno inválido' });
    return;
  }

  const parts = path.split('/').filter((segment) => segment !== '');
  // /rooms/:roomSlug/...
  if (parts[0] !== 'rooms' || typeof parts[1] !== 'string') {
    sendJson(res, 404, { error: 'rota desconhecida' });
    return;
  }
  const roomSlug = decodeURIComponent(parts[1]);

  if (parts.length === 3 && parts[2] === 'rtp-capabilities' && req.method === 'GET') {
    const capabilities = await registry.routerRtpCapabilities(roomSlug);
    sendJson(res, 200, capabilities);
    return;
  }

  if (parts.length === 3 && parts[2] === 'transports' && req.method === 'POST') {
    const body = (await readBody(req)) as Partial<MediasoupCreateTransportBody>;
    const peerId = requireString(body.peerId, 'peerId');
    const direction = body.direction === 'send' || body.direction === 'recv' ? body.direction : null;
    if (direction === null) throw new HttpError(400, "'direction' precisa ser 'send' ou 'recv'");

    const transport = await registry.createTransport(roomSlug, peerId, direction);
    sendJson(res, 200, transportInfo(transport));
    return;
  }

  if (parts.length === 5 && parts[2] === 'transports' && parts[4] === 'connect' && req.method === 'POST') {
    const transportId = parts[3]!;
    const body = (await readBody(req)) as Partial<MediasoupConnectTransportBody>;
    const peerId = requireString(body.peerId, 'peerId');
    if (typeof body.dtlsParameters !== 'object' || body.dtlsParameters === null) {
      throw new HttpError(400, "campo 'dtlsParameters' ausente");
    }
    await registry.connectTransport(
      roomSlug,
      peerId,
      transportId,
      body.dtlsParameters as never,
    );
    sendJson(res, 200, { ok: true });
    return;
  }

  if (parts.length === 5 && parts[2] === 'transports' && parts[4] === 'produce' && req.method === 'POST') {
    const transportId = parts[3]!;
    const body = (await readBody(req)) as Partial<MediasoupProduceBody>;
    const peerId = requireString(body.peerId, 'peerId');
    const kind = body.kind === 'audio' || body.kind === 'video' ? body.kind : null;
    if (kind === null) throw new HttpError(400, "'kind' precisa ser 'audio' ou 'video'");
    if (typeof body.rtpParameters !== 'object' || body.rtpParameters === null) {
      throw new HttpError(400, "campo 'rtpParameters' ausente");
    }
    const trackKind = body.trackKind;
    if (
      trackKind !== 'mic' &&
      trackKind !== 'camera' &&
      trackKind !== 'screen-video' &&
      trackKind !== 'screen-audio'
    ) {
      throw new HttpError(400, "'trackKind' inválido");
    }

    const producer = await registry.produce(
      roomSlug,
      peerId,
      transportId,
      kind,
      body.rtpParameters as never,
      trackKind,
    );
    const result: MediasoupProduceResult = { producerId: producer.id };
    sendJson(res, 200, result);
    return;
  }

  if (parts.length === 5 && parts[2] === 'transports' && parts[4] === 'consume' && req.method === 'POST') {
    const transportId = parts[3]!;
    const body = (await readBody(req)) as Partial<MediasoupConsumeBody>;
    const peerId = requireString(body.peerId, 'peerId');
    const producerId = requireString(body.producerId, 'producerId');
    if (typeof body.rtpCapabilities !== 'object' || body.rtpCapabilities === null) {
      throw new HttpError(400, "campo 'rtpCapabilities' ausente");
    }

    const consumer = await registry.consume(
      roomSlug,
      peerId,
      transportId,
      producerId,
      body.rtpCapabilities as never,
    );
    const result: MediasoupConsumeResult = {
      id: consumer.id,
      producerId: consumer.producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    };
    sendJson(res, 200, result);
    return;
  }

  if (parts.length === 4 && parts[2] === 'consumers' && req.method === 'POST' && url.searchParams.get('action') === 'resume') {
    const consumerId = parts[3]!;
    const body = (await readBody(req)) as { peerId?: unknown };
    const peerId = requireString(body.peerId, 'peerId');
    await registry.resumeConsumer(roomSlug, peerId, consumerId);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (parts.length === 3 && parts[2] === 'published' && req.method === 'GET') {
    const peerId = url.searchParams.get('peerId') ?? '';
    if (peerId === '') throw new HttpError(400, "query 'peerId' ausente");
    sendJson(res, 200, { tracks: registry.publishedTracks(roomSlug, peerId) });
    return;
  }

  if (parts.length === 3 && parts[2] === 'leave' && req.method === 'POST') {
    const body = (await readBody(req)) as { peerId?: unknown };
    const peerId = requireString(body.peerId, 'peerId');
    registry.removePeer(roomSlug, peerId);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: 'rota desconhecida' });
}
