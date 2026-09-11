import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/**
 * Formato único de erro: `{ error: { code, message, details? } }`.
 *
 * Nada de stack, nome de tabela ou texto de driver na resposta — mensagem de
 * erro de banco é mapa do schema para quem estiver sondando. O detalhe cru vai
 * para o log do servidor, com o `code` servindo de ponte entre o que a pessoa
 * viu e o que aconteceu.
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpErrorFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const body: ErrorBody =
        typeof payload === 'object' && payload !== null && 'error' in payload
          ? (payload as ErrorBody)
          : {
              error: {
                code: defaultCodeFor(status),
                message: typeof payload === 'string' ? payload : exception.message,
              },
            };
      response.status(status).json(body);
      return;
    }

    this.logger.error(
      `${request.method} ${request.path} falhou`,
      exception instanceof Error ? exception.stack : String(exception),
    );

    /*
     * `DEBUG_ERRORS=1` devolve a causa no corpo, e fora isso nada muda.
     *
     * Existe porque numa função serverless o log do servidor pode ser
     * inalcançável — a API da Vercel não expõe log de runtime, e sem isso um
     * 500 fica indistinguível de outro: é a diferença entre "o banco recusou"
     * e "faltou variável", e nenhuma das duas aparece na resposta genérica.
     *
     * FECHADO por padrão, e é assim que tem que ficar: mensagem de erro de
     * banco é mapa do schema para quem estiver sondando. Ligar isto é medida
     * temporária de diagnóstico, não configuração de produção.
     */
    const debug = process.env.DEBUG_ERRORS === '1';
    const details =
      debug && exception instanceof Error
        ? { name: exception.name, message: exception.message, stack: exception.stack?.split('\n').slice(0, 6) }
        : undefined;

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: {
        code: 'internal',
        message: 'Erro interno. Tente de novo.',
        ...(details === undefined ? {} : { details }),
      },
    } satisfies ErrorBody);
  }
}

function defaultCodeFor(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'invalid_request';
    case HttpStatus.UNAUTHORIZED:
      return 'unauthorized';
    case HttpStatus.FORBIDDEN:
      return 'forbidden';
    case HttpStatus.NOT_FOUND:
      return 'not_found';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'rate_limited';
    default:
      return 'error';
  }
}
