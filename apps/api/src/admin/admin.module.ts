import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { MetricsService } from './metrics.service';

@Module({
  controllers: [AdminController],
  providers: [AdminService, MetricsService],
})
export class AdminModule {}
