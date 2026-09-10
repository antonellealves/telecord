import { Controller, Get } from '@nestjs/common';
import type { AuthUser } from '@telecord/shared';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthService } from '../auth/auth.service';
import type { AccessClaims } from '../auth/tokens';

/**
 * Perfil próprio. Nenhuma rota aqui é `@Public()`, então todas exigem sessão
 * pelo guard global — é o comportamento padrão que o §5.3 do documento pede.
 */
@Controller('users')
export class UsersController {
  constructor(private readonly auth: AuthService) {}

  @Get('me')
  async me(@CurrentUser() claims: AccessClaims | undefined): Promise<AuthUser> {
    return this.auth.me(claims?.sub ?? '');
  }
}
