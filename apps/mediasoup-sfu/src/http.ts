import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type {
  MediasoupConnectTransportBody,
  MediasoupConsumeBody,
  MediasoupConsumeResult,
  MediasoupCreateTransportBody,
  MediasoupProduceBody,
  MediasoupProduceResult,
  MediasoupTransportInfo,
} from '@telecord/shared';
import { pushModerationCommand } from './presence';
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
 * As rotas `/rooms/*` daqui continuam só para `apps/api` (ver
 * `apps/api/src/mediasoup/mediasoup.service.ts`), autenticado pelo Bearer
 * `internalSecret`. Este mesmo `http.Server` também carrega, em caminhos
 * separados, os dois canais expostos PUBLICAMENTE ao navegador — `/presence`
 * (Socket.IO, ver `presence.ts`) e `/signal` (o canal de mídia, ver
 * `signal/server.ts`) —, com outro mecanismo de auth (token de curta
 * duração, não o Bearer). Convivem na mesma porta porque o Caddy da VM
 * (`infra/Caddyfile`) já encaminha essa porta inteira para fora via
 * `MEDIASOUP_PUBLIC_HOST`.
 *
 * As rotas de transporte, produce e consume daqui são o caminho ANTIGO da
 * sinalização: o navegador as alcançava pelo proxy `/api/mediasoup/*`, com a
 * função serverless e o banco no meio. Continuam de pé para a aba que ainda
 * roda o cliente anterior e para o cliente novo que não conseguiu abrir o
 * canal de mídia; o que é de moderação e de presença (`leave`, `presence`,
 * `command`) segue sendo daqui mesmo.
 *
 * Sem framework (Express/Nest): é um processo pequeno, de responsabilidade
 * única, e a lista de rotas cabe inteira nesta função sem perder legibilidade.
 */
export function startHttpServer(
  port: number,
  internalSecret: string,
  registry: RoomRegistry,
  nodeStats: () => unknown,
): Server {
  const server = createServer((req, res) => {
    void handle(req, res, internalSecret, registry, nodeStats).catch((error) => {
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
  return server;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  internalSecret: string,
  registry: RoomRegistry,
  nodeStats: () => unknown,
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

  // Quanto este nó está carregando: Workers, CPU de cada um, salas e tracks.
  // É a leitura que responde "está na hora de uma máquina maior?" — atrás do
  // Bearer porque conta quantas salas existem, e isso não é público.
  if (path === '/node' && req.method === 'GET') {
    sendJson(res, 200, nodeStats());
    return;
  }

  const parts = path.split('/').filter((segment) => segment !== '');
  if (parts[0] !== 'rooms') {
    sendJson(res, 404, { error: 'rota desconhecida' });
    return;
  }

  // /rooms/presence — agregado de todas as salas, sem :roomSlug. Alimenta
  // `MediasoupService.liveRooms()` (antes lia `PeerPresence` do Prisma).
  if (parts.length === 2 && parts[1] === 'presence' && req.method === 'GET') {
    sendJson(res, 200, { rooms: registry.listRoomsWithPresence() });
    return;
  }

  if (typeof parts[1] !== 'string') {
    sendJson(res, 404, { error: 'rota desconhecida' });
    return;
  }
  const roomSlug = decodeURIComponent(parts[1]);

  // /rooms/:roomSlug/presence — quem está na sala agora. Alimenta
  // `MediasoupModerationService.liveParticipants()`.
  if (parts.length === 3 && parts[2] === 'presence' && req.method === 'GET') {
    sendJson(res, 200, { peers: registry.listPresence(roomSlug) });
    return;
  }

  if (parts.length === 3 && parts[2] === 'rtp-capabilities' && req.method === 'GET') {
    // As mesmas para qualquer sala — perguntar não cria nada no Worker. Ver
    // `RoomRegistry.routerRtpCapabilities`.
    sendJson(res, 200, registry.routerRtpCapabilities);
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
    const body = (await readBody(req)) as { peerId?: unknown; kicked?: unknown };
    const peerId = requireString(body.peerId, 'peerId');
    // `kicked` vem só da moderação (`MediasoupModerationService`). Muda o
    // código com que os canais do par são fechados: expulso não reconecta.
    registry.removePeer(roomSlug, peerId, body.kicked === true ? 'kicked' : 'left');
    sendJson(res, 200, { ok: true });
    return;
  }

  // Empurra mute/move para UM peer ao vivo — ver `pushModerationCommand` em
  // `presence.ts`. Chamado por `MediasoupSfuClient.pushCommand` (apps/api)
  // logo depois de `MediasoupModerationService` escrever o comando no Prisma;
  // a escrita continua sendo a fonte de verdade, isto só acelera a entrega.
  // path: /rooms/:roomSlug/peers/:peerId/command
  if (parts.length === 5 && parts[2] === 'peers' && parts[4] === 'command' && req.method === 'POST') {
    const peerId = parts[3]!;
    const body = (await readBody(req)) as { forceMuted?: unknown; moveTo?: unknown };
    const forceMuted = typeof body.forceMuted === 'boolean' ? body.forceMuted : undefined;
    const moveTo = typeof body.moveTo === 'string' || body.moveTo === null ? body.moveTo : undefined;
    pushModerationCommand({ roomSlug, peerId, forceMuted, moveTo });
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: 'rota desconhecida' });
}
