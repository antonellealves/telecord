import { Module } from '@nestjs/common';
import { MediasoupController } from './mediasoup.controller';
import { MediasoupSfuClient } from './mediasoup-sfu.client';
import { MediasoupService } from './mediasoup.service';

@Module({
  controllers: [MediasoupController],
  providers: [MediasoupService, MediasoupSfuClient],
})
export class MediasoupModule {}
