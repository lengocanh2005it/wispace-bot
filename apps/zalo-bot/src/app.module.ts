import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { HealthController } from '@wispace/bot-common';
import { DatabaseModule } from './infrastructure/database/database.module';
import { RedisModule } from '@wispace/bot-common';
import { ZaloOauthModule } from './modules/zalo-oauth/zalo-oauth.module';
import { ZaloChatModule } from './modules/zalo-chat/zalo-chat.module';
import { ZaloWebhookModule } from './modules/zalo-webhook/zalo-webhook.module';
import { ZaloSharedModule } from './modules/zalo-shared/zalo-shared.module';
import { ZaloStudyReminderModule } from './modules/zalo-study-reminder/zalo-study-reminder.module';
import { ZaloReportModule } from './modules/zalo-chat/zalo-report.module';
import { ZaloOpsModule } from './modules/zalo-ops/zalo-ops.module';
import { createMetricsModule } from '@wispace/bot-metrics';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Own .env wins; falls back to root .env.shared for cross-bot vars
      // (WISPACE_INTERNAL_KEY, OPENAI_*, DB_*...) — see .env.shared.example.
      envFilePath: ['.env', '../../.env.shared'],
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    RedisModule,
    ZaloSharedModule,
    ZaloOauthModule,
    ZaloChatModule,
    ZaloWebhookModule,
    ZaloStudyReminderModule,
    ZaloReportModule,
    ZaloOpsModule,
    createMetricsModule('zalo', 'zalo-bot'),
  ],
})
export class AppModule {}
