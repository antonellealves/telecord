/**
 * TEMPORÁRIO: importa só o Prisma, sem o Nest, para separar as duas metades
 * do pacote. Se ISTO falhar, o peso/engine do Prisma é a causa; se responder,
 * a causa está do lado do Nest.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export default async function handler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const out: Record<string, unknown> = {};
  try {
    const m = await import('@prisma/client');
    out.prisma = typeof (m as { PrismaClient?: unknown }).PrismaClient;
  } catch (error) {
    out.prismaError = String(error);
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(out, null, 2));
}
