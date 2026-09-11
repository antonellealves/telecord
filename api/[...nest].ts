/**
 * TEMPORÁRIO: import dinâmico do bundle, em try/catch, para ler o erro de
 * execução. O build já está limpo (nenhum erro de TypeScript no log), então o
 * que resta é runtime — e agora o try/catch tem chance de rodar, porque não há
 * import estático que possa matar o módulo antes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const m = (await import('./_bundle/nest.cjs')) as unknown as { default?: NodeHandler };
    const fn = m.default ?? (m as unknown as NodeHandler);
    if (typeof fn !== 'function') throw new TypeError(`veio ${typeof fn}`);
    fn(req, res);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify(
        { erroReal: String(error).slice(0, 500), stack: (error as Error)?.stack?.split('\n').slice(0, 12) },
        null,
        2,
      ),
    );
  }
}
