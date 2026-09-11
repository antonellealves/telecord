/**
 * Ponte entre o roteamento da Vercel e o serviço NestJS.
 *
 * Captura tudo sob `/api/` que não tenha função própria.
 *
 * TEMPORÁRIO: o import do serviço está DENTRO do handler, em try/catch, e o
 * erro vira resposta. Enquanto a função morria no carregamento, o erro não
 * aparecia em lugar nenhum — nem stack, nem log, só
 * FUNCTION_INVOCATION_FAILED. Assim ele fica legível e o diagnóstico para de
 * depender de palpite. Volta a ser import estático quando a causa estiver
 * corrigida.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let nest: NodeHandler;
  try {
    const mod = (await import('@telecord/api/vercel')) as unknown as {
      default?: NodeHandler;
    };
    const fn = mod.default ?? (mod as unknown as NodeHandler);
    if (typeof fn !== 'function') {
      throw new TypeError(`o módulo não exportou função (veio ${typeof fn})`);
    }
    nest = fn;
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify(
        {
          error: { code: 'nest_load_failed', message: String(error) },
          stack: (error as Error)?.stack?.split('\n').slice(0, 12),
        },
        null,
        2,
      ),
    );
    return;
  }

  nest(req, res);
}
