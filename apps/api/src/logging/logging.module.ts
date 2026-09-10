import { Global, Module } from '@nestjs/common';
import { LogService } from './log.service';

/**
 * Global pelo mesmo motivo da configuração: praticamente todo módulo escreve
 * no registro de eventos, e um módulo que precisasse importar `LoggingModule`
 * para logar acabaria não logando.
 */
@Global()
@Module({
  providers: [LogService],
  exports: [LogService],
})
export class LoggingModule {}
