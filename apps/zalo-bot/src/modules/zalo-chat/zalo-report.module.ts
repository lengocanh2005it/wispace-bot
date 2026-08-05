import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import { PlatformStudentReportService } from '@wispace/student-report';
import { PlatformLlmUsageRecorderAdapter } from '@wispace/chat-metering';
import { WispaceGoalsService } from '@wispace/wispace-client';
import type { LlmProviderAdapter } from '@wispace/llm-agent';
import { ZaloAccountLinkEntity } from '../../infrastructure/database/entities/zalo-account-link.entity';
import { ScheduledReportClaimEntity } from '@wispace/database';
import { ZaloChatModule } from './zalo-chat.module';
import { ZaloWispaceModule } from '../wispace/zalo-wispace.module';
import { ZaloReportDeliveryService } from './application/services/zalo-report-delivery.service';
import { ZaloReportCronService } from './infrastructure/persistence/zalo-report-cron.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ZaloAccountLinkEntity,
      ScheduledReportClaimEntity,
    ]),
    ZaloChatModule,
    ZaloWispaceModule,
  ],
  providers: [
    ZaloReportDeliveryService,
    ZaloReportCronService,
    {
      provide: PlatformStudentReportService,
      useFactory: (
        configService: ConfigService,
        goalsService: WispaceGoalsService,
        usageRecorder: PlatformLlmUsageRecorderAdapter,
        adapter: LlmProviderAdapter,
      ) =>
        new PlatformStudentReportService(
          'zalo',
          configService,
          goalsService,
          usageRecorder,
          adapter,
          join(__dirname, '../../shared/prompts'),
        ),
      inject: [
        ConfigService,
        WispaceGoalsService,
        PlatformLlmUsageRecorderAdapter,
        'LLM_PROVIDER_ADAPTER',
      ],
    },
  ],
  exports: [ZaloReportCronService],
})
export class ZaloReportModule {}
