import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { DatabaseModule } from './infrastructure/database/database.module';
import {
  BotCommonModule,
  HealthController,
  RedisModule,
} from '@wispace/bot-common';
import { MessengerModule } from './modules/messenger/messenger.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
import { StudentReportModule } from './modules/student-report/student-report.module';
import { StudyReminderModule } from './modules/study-reminder/study-reminder.module';
import { ChatRateLimitModule } from './modules/chat-rate-limit/chat-rate-limit.module';
import { LlmUsageModule } from './modules/llm-usage/llm-usage.module';
import { MetricsModule } from './modules/metrics/metrics.module';

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
    ThrottlerModule.forRoot(),
    DatabaseModule,
    BotCommonModule,
    RedisModule,
    ScheduleModule.forRoot(),
    StudentReportModule,
    StudyReminderModule,
    MessengerModule,
    SchedulerModule,
    ChatRateLimitModule,
    LlmUsageModule,
    MetricsModule,
  ],
  controllers: [AppController, HealthController],
})
export class AppModule {}
