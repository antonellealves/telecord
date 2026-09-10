import { Module } from '@nestjs/common';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';

@Module({
  controllers: [RoomsController],
  providers: [RoomsService],
  // O módulo de sons precisa do `ensureRoom` e da checagem de papel; o webhook
  // do LiveKit precisa do `touch`. Nenhum dos dois reimplementa a regra.
  exports: [RoomsService],
})
export class RoomsModule {}
