import { Module } from '@nestjs/common';
import { RoomsModule } from '../rooms/rooms.module';
import { SoundsController } from './sounds.controller';
import { SoundsService } from './sounds.service';

@Module({
  // A regra de quem administra a sala mora no `RoomsService`, e é ela que
  // decide quem apaga som dos outros. Duplicá-la aqui seria criar dois lugares
  // onde a permissão pode divergir.
  imports: [RoomsModule],
  controllers: [SoundsController],
  providers: [SoundsService],
})
export class SoundsModule {}
