import { Global, Module } from '@nestjs/common';
import { CONFIG, loadConfig, type AppConfig } from './config';

/**
 * Configuração como provider global.
 *
 * Global porque quase todo módulo precisa dela — `MailService` para saber o
 * modo de envio, `AuthGuard` para a chave pública, o controller para os
 * cookies. Declarada só em `AppModule`, ela não atravessa a fronteira de
 * módulo e cada um teria de reimportá-la.
 *
 * `useFactory` e não `useValue` para a leitura acontecer no boot do Nest, onde
 * a falha vira mensagem de inicialização, e não no `import` do arquivo — que
 * quebraria antes de qualquer logger existir.
 */
@Global()
@Module({
  providers: [{ provide: CONFIG, useFactory: (): AppConfig => loadConfig() }],
  exports: [CONFIG],
})
export class ConfigModule {}
