import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const webDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webDir, '../..');
const sharedEntry = path.resolve(repoRoot, 'packages/shared/src/index.ts');
const apiDir = path.resolve(repoRoot, 'api');

/** Só nomes simples viram caminho de arquivo — nada de "../". */
const API_ROUTE = /^\/api\/([a-z0-9-]{1,32})\/?$/;

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/**
 * `vite dev` não executa as funções da Vercel. Este plugin monta os handlers de
 * `api/*.ts` no middleware do próprio Vite, então dev e produção falam com a
 * mesma origem e o mesmo código. Só existe em `serve`.
 *
 * As credenciais entram via process.env (lidas com loadEnv) e NUNCA por
 * `define` — nada disso pode encostar no bundle do navegador.
 */
function apiDevPlugin(env: Record<string, string>): Plugin {
  return {
    name: 'telecord:api-dev',
    apply: 'serve',
    configureServer(server) {
      for (const key of ['LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] as const) {
        const value = env[key];
        if (!process.env[key] && value) {
          process.env[key] = value;
        }
      }

      server.middlewares.use((req, res, next) => {
        const match = API_ROUTE.exec((req.url ?? '').split('?')[0] ?? '');
        if (match === null) {
          next();
          return;
        }
        const handlerPath = path.join(apiDir, `${match[1] ?? ''}.ts`);
        // Sem handler, responde 404 aqui mesmo. Deixar seguir cairia no
        // fallback da SPA e devolveria o index.html com status 200 — em
        // produção o rewrite do vercel.json dá 404, e dev tem que espelhar
        // isso: 200 com HTML vira erro de JSON parse do outro lado.
        if (!existsSync(handlerPath)) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(
            JSON.stringify({
              error: { code: 'NOT_FOUND', message: `Nenhum handler para ${req.url ?? ''}.` },
            }),
          );
          return;
        }

        void (async () => {
          try {
            const loaded = await server.ssrLoadModule(handlerPath);
            const handler: unknown = (loaded as { default?: unknown }).default;
            if (typeof handler !== 'function') {
              next();
              return;
            }
            await (handler as NodeHandler)(req, res);
          } catch (error) {
            server.config.logger.error(
              `[telecord:api-dev] falha ao executar ${handlerPath}: ${String(error)}`,
            );
            if (!res.headersSent) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
            }
            res.end(
              JSON.stringify({
                error: {
                  code: 'DEV_HANDLER_FAILED',
                  message: `Falha ao executar ${req.url ?? '/api'} em dev. Veja o terminal do Vite.`,
                },
              }),
            );
          }
        })();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Prefixo '' = carrega TODAS as variáveis do .env da raiz, inclusive as
  // privadas. Elas ficam só neste processo Node; o cliente enxerga apenas
  // import.meta.env.VITE_*.
  const env = loadEnv(mode, repoRoot, '');

  return {
    envDir: repoRoot,
    plugins: [react(), apiDevPlugin(env)],
    resolve: {
      alias: {
        '@telecord/shared': sharedEntry,
      },
    },
    server: {
      port: 5173,
      fs: {
        // api/ e packages/ ficam fora da raiz do app web.
        allow: [repoRoot],
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      rollupOptions: {
        output: {
          // O SDK do LiveKit é grande e muda pouco. Em chunk próprio, um
          // deploy que só mexe no app não invalida o cache dele.
          manualChunks: {
            livekit: ['livekit-client', '@livekit/components-react'],
          },
        },
      },
    },
  };
});
