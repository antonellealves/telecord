import { Module } from '@nestjs/common';
import { IceController } from './ice.controller';
import { IceService } from './ice.service';

@Module({
  controllers: [IceController],
  providers: [IceService],
})
export class IceModule {}
