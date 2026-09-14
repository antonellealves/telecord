/**
 * Envio de atividade de sala (`POST /activity/events`) — chat, mutar,
 * compartilhar tela — para QUALQUER participante, cadastrado ou não.
 *
 * Diferente de `apiClient.ts`: aquele usa o cookie de sessão de conta
 * (`authedFetch`), que anônimo não tem. Aqui a credencial é o MESMO token de
 * participante do LiveKit que o cliente já carrega para conectar na sala —
 * é o que o servidor verifica para confirmar "esta identity mandou este
 * evento" sem exigir conta nenhuma (ver `apps/api/src/livekit/participant-auth.ts`).
 *
 * Falha aqui nunca aparece para quem está na sala: perder um evento de
 * atividade não pode transformar o chat, que funciona pelo canal de dados
 * do LiveKit independentemente disto, num recurso que parece quebrado.
 */
import type { RoomActivityEventInput } from '@telecord/shared';
import { AUTH_API_URL } from './config';

export async function sendActivityEvents(
  participantToken: string,
  events: RoomActivityEventInput[],
): Promise<void> {
  // Mesmo critério do resto do cliente: sem API configurada, o backend
  // inteiro está fora do ar deste ambiente — não é erro, é o estado normal
  // do app publicado sem o serviço (ver `apps/web/src/lib/auth.ts`).
  if (AUTH_API_URL === '' || events.length === 0) {
    return;
  }
  try {
    await fetch(`${AUTH_API_URL}/activity/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${participantToken}`,
      },
      body: JSON.stringify({ events }),
      // `keepalive` deixa o navegador terminar o envio mesmo se a aba fechar
      // logo em seguida — útil para o evento de "parei de compartilhar"
      // disparado bem perto de sair da sala.
      keepalive: true,
    });
  } catch {
    // Silencioso de propósito — ver o comentário do módulo.
  }
}
