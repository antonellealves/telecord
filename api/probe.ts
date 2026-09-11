/**
 * TEMPORÁRIO: prova de vida de uma função de nome comum, para comparar com
 * `[...nest].ts`. Não importa nada de fora de `api/`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export default function probe(req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: true, url: req.url }));
}
