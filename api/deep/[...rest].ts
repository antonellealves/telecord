/**
 * TEMPORÁRIO: catch-all em subpasta, sem importar nada de fora, para saber se
 * o problema é o PADRÃO `[...x]` no roteamento ou o conteúdo do `[...nest]`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export default function rest(req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ catchAll: true, url: req.url }));
}
