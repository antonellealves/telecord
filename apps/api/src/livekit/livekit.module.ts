import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module';
import { RoomsModule } from '../rooms/rooms.module';
import { LiveKitController } from './livekit.controller';
import { LiveKitService } from './livekit.service';

@Module({
  // RoomsModule: o `touchOrCreate` marca atividade na sala quando alguém
  // entra — é o que ordena o diretório pela sala mais movimentada.
  // ActivityModule: `room.join`/`room.leave` são gravados aqui, a partir do
  // webhook (o servidor testemunhando), não de um relato do cliente.
  imports: [RoomsModule, ActivityModule],
  controllers: [LiveKitController],
  providers: [LiveKitService],
})
export class LiveKitModule {}
