import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  Req,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  validateDisplayName,
  validateEmail,
  validatePassword,
  type AuthSessionResponse,
  type AuthUser,
} from '@telecord/shared';
import { CONFIG, type AppConfig } from '../common/config';
import {
  OAUTH_COOKIE,
  REFRESH_COOKIE,
  clearOAuthCookie,
  clearRefreshCookie,
  readCookie,
  setOAuthCookie,
  setRefreshCookie,
} from '../common/cookies';
import { badRequest } from '../common/errors';
import { AuthService, type ClientInfo, type IssuedSession } from './auth.service';
import { CurrentUser, Public } from './auth.decorators';
import type { AccessClaims } from './tokens';

function clientInfo(request: Request): ClientInfo {
  return { ip: request.ip, userAgent: request.get('user-agent') ?? undefined };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw badRequest('invalid_request', `Campo "${field}" ausente ou inválido.`);
  }
  return value;
}

/** Primeira falha corta, como o resto do contrato em `@telecord/shared`. */
function check(...errors: (string | null)[]): void {
  for (const error of errors) {
    if (error !== null) {
      throw badRequest('invalid_request', error);
    }
  }
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Manda o refresh no cookie e devolve só o access no corpo.
   *
   * O access fica na memória do cliente, nunca em `localStorage` — qualquer XSS
   * lê `localStorage`. O refresh, que é o token de vida longa, o JavaScript da
   * página não alcança: é `httpOnly`.
   */
  private respondWithSession(response: Response, issued: IssuedSession): AuthSessionResponse {
    setRefreshCookie(response, this.config, issued.refreshToken, issued.refreshExpiresAt);
    return issued.response;
  }

  @Public()
  @Get('providers')
  providers(): { password: boolean; google: boolean } {
    return this.auth.availableProviders();
  }

  // -------------------------------------------------------------------------
  // Senha
  // -------------------------------------------------------------------------

  /*
   * Limites apertados nas rotas de credencial. Sem eles, `login` vira oráculo
   * de força bruta e `forgot` vira máquina de mandar e-mail para terceiros.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  async register(
    @Body() body: Record<string, unknown>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthSessionResponse> {
    const email = requireString(body.email, 'email');
    const password = requireString(body.password, 'password');
    const displayName = requireString(body.displayName, 'displayName');
    check(validateEmail(email), validatePassword(password), validateDisplayName(displayName));

    const issued = await this.auth.register({ email, password, displayName }, clientInfo(request));
    return this.respondWithSession(response, issued);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: Record<string, unknown>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthSessionResponse> {
    const email = requireString(body.email, 'email');
    const password = requireString(body.password, 'password');
    // Sem validar formato aqui: a resposta precisa ser a mesma para credencial
    // errada e para e-mail malformado, senão vira sonda de existência.
    const issued = await this.auth.login({ email, password }, clientInfo(request));
    return this.respondWithSession(response, issued);
  }

  /**
   * Chegado por clique no e-mail, então responde com redirect e não com JSON —
   * é o navegador abrindo o link, não a SPA chamando a API.
   */
  @Public()
  @Get('verify')
  async verify(@Query('token') token: string | undefined, @Res() response: Response): Promise<void> {
    try {
      await this.auth.verifyEmail(requireString(token, 'token'));
      response.redirect(`${this.config.appUrl}/entrar?verificado=1`);
    } catch {
      response.redirect(`${this.config.appUrl}/entrar?erro=link_invalido`);
    }
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('password/forgot')
  @HttpCode(HttpStatus.ACCEPTED)
  async forgot(@Body() body: Record<string, unknown>): Promise<{ ok: true }> {
    await this.auth.forgotPassword(requireString(body.email, 'email'));
    // Sempre 202, exista a conta ou não.
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('password/reset')
  @HttpCode(HttpStatus.OK)
  async reset(@Body() body: Record<string, unknown>): Promise<{ ok: true }> {
    const token = requireString(body.token, 'token');
    const password = requireString(body.password, 'password');
    check(validatePassword(password));
    await this.auth.resetPassword(token, password);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Google
  // -------------------------------------------------------------------------

  @Public()
  @Get('google')
  start(@Res() response: Response): void {
    const { url, cookie } = this.auth.startGoogle();
    setOAuthCookie(response, this.config, cookie);
    response.redirect(url);
  }

  /**
   * Volta do Google e termina na SPA, sempre por redirect.
   *
   * O access token NÃO vai na URL: endereço fica no histórico, no Referer e no
   * log de qualquer proxy no caminho. Só o cookie de refresh atravessa, e a SPA
   * troca por um access chamando `/auth/refresh` ao carregar.
   */
  @Public()
  @Get('google/callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    clearOAuthCookie(response, this.config);

    if (error !== undefined || code === undefined || state === undefined) {
      // Inclui o caso de quem clicou em "cancelar" na tela do Google.
      response.redirect(`${this.config.appUrl}/entrar?erro=google_cancelado`);
      return;
    }

    try {
      const issued = await this.auth.finishGoogle(
        { code, state, cookie: readCookie(request, OAUTH_COOKIE) },
        clientInfo(request),
      );
      setRefreshCookie(response, this.config, issued.refreshToken, issued.refreshExpiresAt);
      response.redirect(`${this.config.appUrl}/entrar/retorno`);
    } catch (failure) {
      const code = extractErrorCode(failure);
      response.redirect(`${this.config.appUrl}/entrar?erro=${encodeURIComponent(code)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Sessão corrente
  // -------------------------------------------------------------------------

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthSessionResponse> {
    try {
      const issued = await this.auth.refresh(
        readCookie(request, REFRESH_COOKIE),
        clientInfo(request),
      );
      return this.respondWithSession(response, issued);
    } catch (failure) {
      // Cookie que não vale mais só atrapalha: sem limpar, toda carga da página
      // repete a mesma falha até alguém limpar o navegador à mão.
      clearRefreshCookie(response, this.config);
      throw failure;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(readCookie(request, REFRESH_COOKIE));
    clearRefreshCookie(response, this.config);
  }

  /** Protegida pelo guard global: sem `@Public()`, exige access token. */
  @Get('me')
  async me(@CurrentUser() claims: AccessClaims | undefined): Promise<AuthUser> {
    return this.auth.me(claims?.sub ?? '');
  }
}

function extractErrorCode(failure: unknown): string {
  if (
    typeof failure === 'object' &&
    failure !== null &&
    'getResponse' in failure &&
    typeof (failure as { getResponse: unknown }).getResponse === 'function'
  ) {
    const body = (failure as { getResponse: () => unknown }).getResponse();
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const inner = (body as { error: unknown }).error;
      if (typeof inner === 'object' && inner !== null && 'code' in inner) {
        const value = (inner as { code: unknown }).code;
        if (typeof value === 'string') return value;
      }
    }
  }
  return 'google_falhou';
}
