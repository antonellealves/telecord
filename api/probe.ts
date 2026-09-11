/**
 * TEMPORÁRIO: o `diag` já provou que o módulo CARREGA. Este vai além e o
 * EXECUTA, que é o que `[...nest].ts` faz — booting do Nest incluído — com o
 * erro virando resposta em vez de matar a função.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export default async function probe(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const m = await import('../apps/api/dist/src/vercel.js');
    const fn = (m as unknown as { default: (a: unknown, b: unknown) => void }).default;
    fn(req, res);
  } catch (error) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify(
        { error: String(error), stack: (error as Error)?.stack?.split('\n').slice(0, 15) },
        null,
        2,
      ),
    );
  }
}
