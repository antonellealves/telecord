import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CONFIG, type AppConfig } from '../common/config';
import { forbidden, unauthorized } from '../common/errors';
import { IS_OPTIONAL, IS_PUBLIC, REQUIRED_ROLES, type RequestWithUser } from './auth.decorators';
import { verifyAccessToken } from './tokens';

/**
 * Guard global de sessão e papel.
 *
 * Global de propósito: registrado em `APP_GUARD`, ele vale para todo controller
 * do serviço, inclusive os que ainda não existem. Proteger rota por rota é o
 * arranjo que o §5.3 do documento proíbe, porque a rota que alguém esquecer de
 * anotar nasce aberta.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets) === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const optional = this.reflector.getAllAndOverride<boolean>(IS_OPTIONAL, targets) === true;
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) {
      if (optional) return true;
      throw unauthorized('unauthorized', 'Faça login para continuar.');
    }

    try {
      request.user = await verifyAccessToken(this.config.jwtPublicKey, header.slice(7));
    } catch {
      /*
       * Rota opcional segue como anônima. Sem isto, a sessão de alguém expirar
       * no meio de um clique viraria um erro em vez de simplesmente devolver a
       * versão pública da resposta — e o `request.user` continua indefinido,
       * então nada abaixo confunde "token ruim" com "está autenticado".
       */
      if (optional) return true;
      // Expirado, assinatura inválida, emissor errado: a distinção interessa ao
      // log, não a quem chamou — detalhar aqui vira oráculo para quem sonda.
      throw unauthorized('unauthorized', 'Sessão inválida ou expirada.');
    }

    const roles = this.reflector.getAllAndOverride<string[]>(REQUIRED_ROLES, targets);
    if (roles !== undefined && roles.length > 0 && !roles.includes(request.user.role)) {
      throw forbidden('forbidden', 'Você não tem acesso a isto.');
    }
    return true;
  }
}
