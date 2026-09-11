/**
 * Ponte entre o roteamento da Vercel e o serviço NestJS.
 *
 * Carrega o bundle de `api-bundle/`, montado por `scripts/bundle-api.mjs`, e
 * copiado para o pacote da função pelo `includeFiles` do `vercel.json`.
 *
 * O import é DINÂMICO e dentro de try/catch de propósito: enquanto o
 * carregamento acontecia no topo do módulo, qualquer falha matava a função
 * antes de qualquer código rodar, e o erro não aparecia em lugar nenhum —
 * nem stack, nem log, só FUNCTION_INVOCATION_FAILED. Assim, uma falha de
 * carregamento vira resposta legível em vez de tela preta.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;

let cached: NodeHandler | null = null;

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    if (cached === null) {
      const m = (await import('../api-bundle/bundle/nest.cjs')) as unknown as {
        default?: NodeHandler;
      };
      const fn = m.default ?? (m as unknown as NodeHandler);
      if (typeof fn !== 'function') {
        throw new TypeError(`o bundle não exportou função (veio ${typeof fn})`);
      }
      cached = fn;
    }
    cached(req, res);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify(
        {
          error: { code: 'bundle_load_failed', message: String(error).slice(0, 400) },
          stack: (error as Error)?.stack?.split('\n').slice(0, 10),
        },
        null,
        2,
      ),
    );
  }
}
