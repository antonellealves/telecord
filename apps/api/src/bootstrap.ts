import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AppConfig } from './common/config';

/**
 * Configuração comum aos dois modos de execução.
 *
 * Existe porque o serviço sobe de duas formas — processo próprio (`main.ts`,
 * Docker local) e função da Vercel (`vercel.ts`) — e configurar cada uma no seu
 * arquivo faria as duas divergirem sem ninguém notar. Uma divergência em CORS
 * ou no prefixo de rota só aparece em produção.
 */

/**
 * Prefixo fixo, e não derivado da `API_URL`.
 *
 * Na Vercel, `/api/*` é o que sobra para as funções depois do rewrite da SPA,
 * então o serviço precisa responder embaixo dele. Fixar aqui faz o formato das
 * rotas ser o mesmo em desenvolvimento e em produção — daí a `API_URL` local
 * também terminar em `/api`.
 */
export const GLOBAL_PREFIX = 'api';

export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  /*
   * Sem isto o Express reporta o IP do balanceador em `req.ip`, e o limitador
   * de requisições conta o mundo inteiro como um cliente só — quem abusa
   * derruba todo mundo junto.
   */
  app.set('trust proxy', 1);
  app.setGlobalPrefix(GLOBAL_PREFIX);

  /*
   * Na Vercel a SPA e a API dividem a origem, e o CORS nem chega a ser
   * consultado. A configuração fica para o desenvolvimento local, onde o Vite
   * está em :5173 e a API em :3000 — e é o que faz o cookie de refresh viajar
   * entre os dois. Origem única e fixa: `*` é proibido junto de `credentials`,
   * e com razão.
   */
  app.enableCors({
    origin: config.appUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.use(
    (
      _request: unknown,
      response: { setHeader: (key: string, value: string) => void },
      next: () => void,
    ) => {
      // A API só devolve JSON: nada aqui deve ser adivinhado pelo navegador,
      // embutido em outra página ou virar referência de origem para terceiro.
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Cache-Control', 'no-store');
      next();
    },
  );
}
