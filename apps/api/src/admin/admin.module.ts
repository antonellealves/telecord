import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { MetricsService } from './metrics.service';
import { ModerationService } from './moderation.service';

@Module({
  controllers: [AdminController],
  providers: [AdminService, MetricsService, ModerationService],
})
export class AdminModule {}
