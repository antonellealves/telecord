import { Module } from '@nestjs/common';
import { PeersModule } from '../peers/peers.module';
import { MediasoupController } from './mediasoup.controller';
import { MediasoupSfuClient } from './mediasoup-sfu.client';
import { MediasoupService } from './mediasoup.service';

@Module({
  // PeersModule empresta PeersService — o heartbeat inicial (antes de emitir
  // o token de presença) continua vivendo lá, ver `MediasoupService.clientConfig`.
  imports: [PeersModule],
  controllers: [MediasoupController],
  providers: [MediasoupService, MediasoupSfuClient],
  exports: [MediasoupSfuClient, MediasoupService],
})
export class MediasoupModule {}
