/**
 * Ponte entre o roteamento da Vercel e o serviço NestJS.
 *
 * Captura tudo sob `/api/` que não tenha função própria. `api/token.ts` e
 * `api/rooms.ts` continuam respondendo pelos caminhos deles: rota com segmento
 * fixo tem precedência sobre rota dinâmica, então a captura só recebe o resto.
 *
 * CARREGA UM BUNDLE, e não o `dist` do serviço. O log de build da Vercel
 * mostra por quê: depois do `buildCommand`, cada arquivo de `api/` é compilado
 * numa ETAPA SEPARADA, com o próprio "Installing dependencies...", que não
 * enxerga o que o build do monorepo produziu. `scripts/bundle-api.mjs` resolve
 * antes, empacotando o serviço num `.cjs` sem dependência externa em
 * `api-bundle/` — fora de `api/`, porque todo `.js` ali dentro viraria uma
 * função serverless própria.
 *
 * Falha de CONFIGURAÇÃO não passa por aqui: o próprio serviço responde 503 com
 * a causa (ver `abortOnError` em `apps/api/src/vercel.ts`). O try/catch abaixo
 * cobre só o que pode dar errado antes disso — o bundle não estar no pacote.
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
      const mod = (await import('../api-bundle/bundle/nest.cjs')) as unknown as {
        default?: NodeHandler;
      };
      const fn = mod.default ?? (mod as unknown as NodeHandler);
      if (typeof fn !== 'function') {
        throw new TypeError(`o bundle não exportou uma função (veio ${typeof fn}).`);
      }
      cached = fn;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('não foi possível carregar o serviço:', message);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: { code: 'service_unavailable', message } }));
    return;
  }

  cached(req, res);
}
