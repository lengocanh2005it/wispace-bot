import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { DatabaseModule } from './infrastructure/database/database.module';
import { BotCommonModule } from '@wispace/bot-common/guard';
import {
  createBotThrottlerOptions,
  RedisModule,
  RedisService,
} from '@wispace/bot-common/redis';
import { HealthController } from '@wispace/bot-common/health';
import { MessengerModule } from './modules/messenger/messenger.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
import { WebActivityModule } from './modules/web-activity/web-activity.module';
import { StudentReportModule } from './modules/student-report/student-report.module';
import { StudyReminderModule } from './modules/study-reminder/study-reminder.module';
import { ChatRateLimitModule } from './modules/chat-rate-limit/chat-rate-limit.module';
import { LlmUsageModule } from './modules/llm-usage/llm-usage.module';
import { createMetricsModule } from '@wispace/bot-metrics';
import { OpsHealthModule } from '@wispace/ops-health';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Own .env wins; falls back to root .env.shared for cross-bot vars
      // (WISPACE_INTERNAL_KEY, OPENAI_*, DB_*...) — see .env.shared.example.
      // Missing files are silently skipped, so this is a no-op when the
      // shared file doesn't exist (e.g. production containers).
      envFilePath: ['.env', '../../.env.shared'],
    }),
    ThrottlerModule.forRootAsync({
      imports: [RedisModule],
      inject: [ConfigService, RedisService],
      useFactory: (configService: ConfigService, redisService: RedisService) =>
        createBotThrottlerOptions(configService, redisService),
    }),
    DatabaseModule,
    BotCommonModule,
    RedisModule,
    ScheduleModule.forRoot(),
    StudentReportModule,
    StudyReminderModule,
    MessengerModule,
    SchedulerModule,
    WebActivityModule,
    ChatRateLimitModule,
    LlmUsageModule,
    createMetricsModule('messenger', 'messenger-ai-for-student'),
    OpsHealthModule.forPlatform('messenger', MessengerModule),
  ],
  controllers: [AppController, HealthController],
  providers: [
    {
      provide: 'INTERNAL_API_KEY_VALIDATION',
      useFactory: (config: ConfigService) => {
        config.getOrThrow<string>('INTERNAL_API_KEY');
        return true;
      },
      inject: [ConfigService],
    },
  ],
})
export class AppModule {}
