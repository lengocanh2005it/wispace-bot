import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { BotCommonModule } from '@wispace/bot-common/guard';
import {
  createBotThrottlerOptions,
  RedisService,
} from '@wispace/bot-common/redis';
import { HealthController } from '@wispace/bot-common/health';
import { DatabaseModule } from './infrastructure/database/database.module';
import { RedisModule } from '@wispace/bot-common/redis';
import { ZaloOauthHttpModule } from './modules/zalo-oauth/zalo-oauth-http.module';
import { ZaloChatModule } from './modules/zalo-chat/zalo-chat.module';
import { ZaloWebhookModule } from './modules/zalo-webhook/zalo-webhook.module';
import { ZaloStudyReminderModule } from './modules/zalo-study-reminder/zalo-study-reminder.module';
import { ZaloReportModule } from './modules/zalo-chat/zalo-report.module';
import { ZaloOpsModule } from './modules/zalo-ops/zalo-ops.module';
import { createMetricsModule } from '@wispace/bot-metrics';
import { OpsHealthModule } from '@wispace/ops-health';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env.shared'],
    }),
    ThrottlerModule.forRootAsync({
      imports: [RedisModule],
      inject: [ConfigService, RedisService],
      useFactory: (configService: ConfigService, redisService: RedisService) =>
        createBotThrottlerOptions(configService, redisService),
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    BotCommonModule,
    RedisModule,
    ZaloOauthHttpModule,
    ZaloChatModule,
    ZaloWebhookModule,
    ZaloStudyReminderModule,
    ZaloReportModule,
    ZaloOpsModule,
    createMetricsModule('zalo', 'zalo-bot'),
    OpsHealthModule.forPlatform('zalo', ZaloOauthHttpModule),
  ],
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
