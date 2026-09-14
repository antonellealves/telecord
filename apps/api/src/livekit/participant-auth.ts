import { jwtVerify } from 'jose';

/**
 * Verifica o token de PARTICIPANTE do LiveKit (o `AccessToken` que
 * `api/token.ts` emite para o cliente entrar na sala) — não confundir com
 * `webhook-auth.ts`, que verifica o token que o próprio SERVIDOR LiveKit usa
 * para chamar de volta o webhook. São dois JWTs diferentes, assinados com a
 * MESMA API secret, mas com formato e propósito distintos.
 *
 * ## Por que isto existe
 *
 * `POST /activity/events` (ver `activity.controller.ts`) precisa saber quem
 * está mandando um evento de sala — inclusive de quem não tem conta, cujo
 * único crachá é este token. Sem verificar a assinatura, qualquer requisição
 * poderia alegar "sou a identity X na sala Y" e forjar fala em nome de
 * outra pessoa. O cliente já carrega este token (é o mesmo que usou para
 * conectar no LiveKit) — não precisa de nenhum sistema de auth novo, só
 * reenviá-lo como Bearer.
 *
 * `identity` vem do claim padrão `sub` do JWT; `room` vem de `video.room`,
 * o grant que `api/token.ts` sempre define (`accessToken.addGrant({ room:
 * roomId, ... })`).
 */
export interface ParticipantClaims {
  identity: string;
  room: string;
  name: string | null;
}

export type ParticipantCheck =
  | { ok: true; claims: ParticipantClaims }
  | { ok: false; reason: string };

export async function verifyParticipantToken(
  authorization: string | undefined,
  apiKey: string,
  apiSecret: string,
): Promise<ParticipantCheck> {
  const token = (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (token === '') {
    return { ok: false, reason: 'sem cabeçalho de autorização' };
  }

  let payload: Record<string, unknown>;
  try {
    // Sem fixar o algoritmo, um token `alg: none` passaria sem segredo
    // nenhum. `issuer: apiKey` confere que foi ESTE projeto que assinou —
    // rejeita um token de participante de outro ambiente/projeto LiveKit.
    const verified = await jwtVerify(token, new TextEncoder().encode(apiSecret), {
      algorithms: ['HS256'],
      issuer: apiKey,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (failure) {
    return { ok: false, reason: `assinatura inválida (${describe(failure)})` };
  }

  const identity = payload.sub;
  if (typeof identity !== 'string' || identity === '') {
    return { ok: false, reason: 'token sem identity (sub)' };
  }

  const video = payload.video;
  const room =
    typeof video === 'object' && video !== null && 'room' in video
      ? (video as { room?: unknown }).room
      : undefined;
  if (typeof room !== 'string' || room === '') {
    return { ok: false, reason: 'token sem sala (video.room)' };
  }

  const name = typeof payload.name === 'string' && payload.name !== '' ? payload.name : null;

  return { ok: true, claims: { identity: identity.slice(0, 64), room: room.slice(0, 64), name } };
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : 'erro desconhecido';
}
