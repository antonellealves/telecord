import { Module } from '@nestjs/common';
import { CfsfuController } from './cfsfu.controller';
import { CfsfuService } from './cfsfu.service';
import { CloudflareRealtimeClient } from './cloudflare-realtime.client';

@Module({
  controllers: [CfsfuController],
  providers: [CfsfuService, CloudflareRealtimeClient],
})
export class CfsfuModule {}
