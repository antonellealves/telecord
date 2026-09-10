import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AccessClaims } from './tokens';

export const IS_PUBLIC = 'auth:public';
export const IS_OPTIONAL = 'auth:optional';
export const REQUIRED_ROLES = 'auth:roles';

/**
 * Abre uma rota. O guard é global (`APP_GUARD`), então rota nova nasce
 * protegida e só sai da proteção com esta marca explícita — que é o §5.3 do
 * documento: rota esquecida falha fechada, não aberta.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/**
 * Aceita com e sem sessão, e diz ao guard qual dos dois é o caso.
 *
 * Não é `@Public()` com um jeito de espiar o token: `@Public()` nem olha o
 * cabeçalho, então uma rota assim não teria como saber quem está perguntando.
 * Também não é rota protegida: exigir login aqui fecharia a porta para o
 * anônimo, que no telecord é usuário de primeira classe.
 *
 * Serve às rotas cuja RESPOSTA muda com quem pergunta, sem que a pergunta em
 * si precise de conta — o painel de sons devolve `canDelete` para o dono do
 * som e não para o resto, e a sala devolve o papel de quem está olhando.
 *
 * Token inválido ou vencido NÃO é erro aqui: cai em anônimo, como se não
 * tivesse vindo nenhum. Recusar seria pior do que ignorar — a sessão de
 * alguém expira no meio da tarde e o painel de sons pararia de carregar.
 */
export const OptionalAuth = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_OPTIONAL, true);

export const Roles = (...roles: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_ROLES, roles);

export interface RequestWithUser extends Request {
  user?: AccessClaims;
}

/** Claims do access token já verificado pelo guard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AccessClaims | undefined =>
    context.switchToHttp().getRequest<RequestWithUser>().user,
);
