/**
 * TEMPORÁRIO: descobre por que `api/[...nest].ts` não carrega em produção.
 *
 * Reproduz o mesmo import DENTRO de um try, e responde o erro em vez de
 * morrer no load. Sai do repositório assim que a causa estiver identificada.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export default async function handler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const out: Record<string, unknown> = {};

  const fs = await import('node:fs');
  const path = await import('node:path');

  out.cwd = process.cwd();
  out.dirname = path.dirname(new URL(import.meta.url).pathname);

  for (const p of [
    '/var/task/apps/api/dist/src/vercel.js',
    '/var/task/apps/api/dist/package.json',
    '/var/task/apps/api/package.json',
  ]) {
    out[p] = fs.existsSync(p);
  }

  try {
    const m = await import('../apps/api/dist/src/vercel.js');
    out.importOk = typeof (m as { default?: unknown }).default;
  } catch (error) {
    out.importError = String(error);
    out.importStack = (error as Error)?.stack?.split('\n').slice(0, 6).join(' | ');
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(out, null, 2));
}
