/**
 * GET /api/rooms — salas ativas no SFU.
 *
 * Esta é a SEGUNDA função serverless do projeto, e ela quebra duas premissas
 * originais do SPEC de propósito: "a única função serverless é a emissão de
 * token" e "sem I/O externo". Não há alternativa — quem sabe quais salas
 * existem é o LiveKit, e essa informação só é acessível pela API de servidor,
 * que exige as credenciais. O cliente não pode perguntar sozinho.
 *
 * A função de token continua pura: isto é um arquivo separado, com o seu
 * próprio custo de latência.
 *
 * CONSEQUÊNCIA DE PRIVACIDADE: a lista é pública. Antes, uma sala só era
 * alcançável por quem tivesse a URL; agora qualquer visitante vê os nomes e
 * entra. Ver §9 do SPEC.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RoomServiceClient } from 'livekit-server-sdk';
import {
  LIVEKIT_HOST,
  type ActiveRoom,
  type RoomsErrorCode,
  type RoomsErrorResponse,
  type RoomsSuccessResponse,
} from '@telecord/shared';

function sendJson(res: ServerResponse, status: number, payload: unknown, cache: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  res.end(JSON.stringify(payload));
}

function sendError(
  res: ServerResponse,
  status: number,
  code: RoomsErrorCode,
  message: string,
): void {
  const body: RoomsErrorResponse = { error: { code, message } };
  sendJson(res, status, body, 'no-store');
}

function log(fields: Record<string, string | number>): void {
  console.log(JSON.stringify({ scope: 'api/rooms', ...fields }));
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const startedAt = Date.now();

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET.');
    return;
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    const missing = [!apiKey && 'LIVEKIT_API_KEY', !apiSecret && 'LIVEKIT_API_SECRET']
      .filter(Boolean)
      .join(' e ');
    log({ code: 'SERVER_MISCONFIGURED', missing });
    sendError(res, 500, 'SERVER_MISCONFIGURED', `Servidor sem credenciais. Configure ${missing}.`);
    return;
  }

  const host = process.env.LIVEKIT_URL ?? `https://${LIVEKIT_HOST}`;

  try {
    const client = new RoomServiceClient(host, apiKey, apiSecret);
    const rooms = await client.listRooms();

    // O LiveKit mantém a sala viva durante o emptyTimeout depois que o último
    // sai. "Ativa" para quem está escolhendo onde entrar é sala COM gente.
    const active: ActiveRoom[] = rooms
      .filter((room) => room.numParticipants > 0)
      .map((room) => ({
        roomId: room.name,
        participants: room.numParticipants,
        startedAt: Number(room.creationTime) * 1000,
      }))
      .sort((a, b) => b.participants - a.participants || a.roomId.localeCompare(b.roomId));

    const payload: RoomsSuccessResponse = { rooms: active };
    log({ code: 'OK', rooms: active.length, durationMs: Date.now() - startedAt });
    // Cache curto na borda: protege a API do LiveKit de quem fica atualizando
    // a página, sem deixar a lista velha o bastante para enganar.
    sendJson(res, 200, payload, 'public, max-age=0, s-maxage=5, stale-while-revalidate=10');
  } catch {
    log({ code: 'UPSTREAM_UNAVAILABLE', durationMs: Date.now() - startedAt });
    sendError(res, 502, 'UPSTREAM_UNAVAILABLE', 'Não foi possível falar com o LiveKit agora.');
  }
}
