/**
 * TEMPORÁRIO: o import ESTÁTICO, que é o que `[...nest].ts` faz.
 *
 * `diag.ts` provou que o import DINÂMICO funciona. Se este arquivo também
 * falhar no load, a diferença é o estático; se responder, a diferença está no
 * NOME do arquivo `[...nest].ts`, não no import.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import handler from '../apps/api/dist/src/vercel.js';

export default function diag2(_req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ staticImport: typeof handler }));
}
