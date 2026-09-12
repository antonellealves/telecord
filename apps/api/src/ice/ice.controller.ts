import { Controller, Get } from '@nestjs/common';
import type { IceConfig } from '@telecord/shared';
import { OptionalAuth } from '../auth/auth.decorators';
import { IceService } from './ice.service';

/**
 * Servidores de gelo (ICE) para o modo direto.
 *
 * ## Por que uma rota, e não uma constante no bundle
 *
 * Duas razões. Trocar ou acrescentar um TURN passa a ser mexer numa variável de
 * ambiente, sem publicar o front de novo. E credencial de TURN temporária não
 * pode viver em JavaScript público: ela é gerada aqui, por requisição, e expira
 * — o que sai daqui é seguro de expor porque morre sozinho.
 *
 * `@OptionalAuth` como o resto do modo direto: entrar numa sala não exige conta,
 * e pedir a lista de ICE muito menos. A resposta é a mesma para todos.
 */
@Controller('ice')
export class IceController {
  constructor(private readonly ice: IceService) {}

  @OptionalAuth()
  @Get()
  get(): IceConfig {
    return this.ice.build();
  }
}
