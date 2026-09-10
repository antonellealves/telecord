import { Module } from '@nestjs/common';
import { RoomsModule } from '../rooms/rooms.module';
import { LiveKitController } from './livekit.controller';
import { LiveKitService } from './livekit.service';

@Module({
  // Precisa do `touch` para marcar atividade na sala quando alguém entra — é
  // o que ordena o diretório pela sala mais movimentada.
  imports: [RoomsModule],
  controllers: [LiveKitController],
  providers: [LiveKitService],
})
export class LiveKitModule {}
