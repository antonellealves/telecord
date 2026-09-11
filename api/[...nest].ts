/**
 * TEMPORÁRIO: de novo com o import dentro de try/catch, para ler o erro que
 * sobrou depois do `node-linker=hoisted`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const out: Record<string, unknown> = {};
  for (const name of ['@prisma/client', '@nestjs/core', '@nestjs/platform-express']) {
    try {
      await import(name as string);
      out[name] = 'ok';
    } catch (error) {
      out[name] = String(error).slice(0, 300);
    }
  }
  try {
    const m = (await import('@telecord/api/vercel')) as unknown as { default?: NodeHandler };
    const fn = m.default ?? (m as unknown as NodeHandler);
    if (typeof fn === 'function') {
      out.servico = 'ok';
      res.setHeader('x-nest', 'ok');
      fn(req, res);
      return;
    }
    out.servico = `veio ${typeof fn}`;
  } catch (error) {
    out.servico = String(error).slice(0, 500);
    out.stack = (error as Error)?.stack?.split('\n').slice(0, 10);
  }
  res.statusCode = 500;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(out, null, 2));
}
