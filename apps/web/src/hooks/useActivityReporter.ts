import { useCallback, useEffect, useRef } from 'react';
import { ROOM_ACTIVITY_BATCH_LIMIT, type RoomActivityEventInput } from '@telecord/shared';
import { sendActivityEvents } from '../lib/activity';

/** Espera antes de enviar: eventos em rajada (várias mensagens seguidas) viram um lote só. */
const FLUSH_DEBOUNCE_MS = 2000;

export interface ActivityReporter {
  report: (event: RoomActivityEventInput) => void;
}

/**
 * Agrega eventos de atividade e manda em lote para `POST /activity/events`.
 *
 * Uma requisição por clique seria desperdício e um vetor de rate-limit fácil
 * de estourar numa sala movimentada — o lote (até `ROOM_ACTIVITY_BATCH_LIMIT`
 * de uma vez) é o que o servidor já espera receber.
 */
export function useActivityReporter(participantToken: string): ActivityReporter {
  const queueRef = useRef<RoomActivityEventInput[]>([]);
  const timerRef = useRef(0);
  const tokenRef = useRef(participantToken);
  tokenRef.current = participantToken;

  const flush = useCallback(() => {
    window.clearTimeout(timerRef.current);
    if (queueRef.current.length === 0) return;
    const batch = queueRef.current.slice(0, ROOM_ACTIVITY_BATCH_LIMIT);
    queueRef.current = queueRef.current.slice(ROOM_ACTIVITY_BATCH_LIMIT);
    void sendActivityEvents(tokenRef.current, batch);
    // Se sobrou mais que um lote (rajada grande), manda o resto na sequência
    // em vez de esperar outro debounce inteiro.
    if (queueRef.current.length > 0) flush();
  }, []);

  const report = useCallback(
    (event: RoomActivityEventInput) => {
      queueRef.current.push(event);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(flush, FLUSH_DEBOUNCE_MS);
    },
    [flush],
  );

  // Ao sair da sala, manda o que sobrou na fila em vez de descartar — é
  // exatamente o caso do "parei de compartilhar" bem antes de desconectar.
  useEffect(() => {
    return () => flush();
  }, [flush]);

  return { report };
}
