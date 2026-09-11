/**
 * TEMPORÁRIO: arquivo mínimo, sem import nenhum além de tipo. Se ISTO falhar,
 * o problema é o arquivo `[...nest].ts` em si — nome ou empacotamento —, e
 * não nada que ele importe.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ vivo: true, url: req.url }));
}
