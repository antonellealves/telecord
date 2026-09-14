import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { MetricsService } from './metrics.service';
import { ModerationService } from './moderation.service';

@Module({
  // ModerationService registra o EFEITO de mutar/mover/remover na tabela de
  // atividade (ver ActivityService.recordModeration) além do ATO na
  // auditoria — a linha existe mesmo para quem sofreu a ação sem ter conta.
  imports: [ActivityModule],
  controllers: [AdminController],
  providers: [AdminService, MetricsService, ModerationService],
})
export class AdminModule {}
