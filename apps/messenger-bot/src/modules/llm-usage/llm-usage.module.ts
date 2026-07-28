import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule } from '../../shared/common/common.module';
import { MessengerOutboundModule } from '../messenger/messenger-outbound.module';
import { LlmUsageEventEntity } from '@wispace/chat-metering';
import { CleanupCronService } from '@wispace/cleanup-cron';
import { LlmUsageCleanupCronService } from './application/services/llm-usage-cleanup-cron.service';
import { LlmUsageCleanupService } from './application/services/llm-usage-cleanup.service';
import { LlmUsageConfigService } from './application/services/llm-usage-config.service';
import { LlmUsageQueryService } from './application/services/llm-usage-query.service';
import { LlmUsageRecorderService } from './application/services/llm-usage-recorder.service';
import { LLM_USAGE_REPOSITORY } from './domain/repositories/llm-usage.repository.port';
import { LlmUsageRepository } from './infrastructure/persistence/llm-usage.repository';
import { LlmUsageController } from './presentation/controllers/llm-usage.controller';

@Module({
  imports: [
    CommonModule,
    MessengerOutboundModule,
    TypeOrmModule.forFeature([LlmUsageEventEntity]),
  ],
  controllers: [LlmUsageController],
  providers: [
    LlmUsageConfigService,
    LlmUsageRepository,
    {
      provide: LLM_USAGE_REPOSITORY,
      useExisting: LlmUsageRepository,
    },
    LlmUsageRecorderService,
    LlmUsageQueryService,
    LlmUsageCleanupService,
    CleanupCronService,
    LlmUsageCleanupCronService,
  ],
  exports: [
    LlmUsageRecorderService,
    LlmUsageConfigService,
    LlmUsageQueryService,
  ],
})
export class LlmUsageModule {}
