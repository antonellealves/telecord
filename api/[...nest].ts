/**
 * TEMPORÁRIO: import dentro de try/catch para ler o erro atual.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const m = (await import('@telecord/api/vercel')) as unknown as { default?: NodeHandler };
    const fn = m.default ?? (m as unknown as NodeHandler);
    if (typeof fn !== 'function') throw new TypeError(`veio ${typeof fn}`);
    fn(req, res);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ erro: String(error).slice(0, 400), stack: (error as Error)?.stack?.split('\n').slice(0, 10) }, null, 2));
  }
}
