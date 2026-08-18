import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSourceOptions } from 'typeorm';
import { ZaloOaTokenEntity } from './entities/zalo-oa-token.entity';
import { ZaloOauthStateEntity } from './entities/zalo-oauth-state.entity';
import { ZaloAccountLinkEntity } from './entities/zalo-account-link.entity';
import { ZaloLinkVerifyRecordEntity } from './entities/zalo-link-verify-record.entity';
import { ZaloMessageLogEntity } from './entities/zalo-message-log.entity';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  LlmUsageEventEntity,
  LlmSafetyEventEntity,
} from '@wispace/chat-metering';
import { StudyReminderJobEntity } from '@wispace/study-reminder-shared';
import {
  ScheduledReportClaimEntity,
  WebhookInboundEventEntity,
  WebhookDeadLetterEntity,
  getPostgresSsl,
} from '@wispace/database';

/**
 * Connects to the same Postgres DB as `apps/messenger-bot` (Phase 2: shared
 * schema keyed by `(platform, external_user_id)`). Does NOT run/own
 * migrations — see `docs/turborepo-migration-plan.md` Phase 5: only
 * messenger-bot's pipeline is allowed to run `migration:run`.
 */
export function buildTypeOrmOptions(config: ConfigService): DataSourceOptions {
  return {
    type: 'postgres',
    host: config.getOrThrow<string>('DB_HOST'),
    port: Number(config.getOrThrow<string>('DB_PORT')),
    username: config.getOrThrow<string>('DB_USER'),
    password: config.getOrThrow<string>('DB_PASSWORD'),
    database: config.getOrThrow<string>('DB_NAME'),
    ssl: getPostgresSsl(config),
    entities: [
      ZaloOaTokenEntity,
      ZaloOauthStateEntity,
      ZaloAccountLinkEntity,
      ZaloMessageLogEntity,
      ZaloLinkVerifyRecordEntity,
      ChatDailyUsageEntity,
      ChatIdempotencyEntity,
      LlmUsageEventEntity,
      LlmSafetyEventEntity,
      StudyReminderJobEntity,
      ScheduledReportClaimEntity,
      WebhookInboundEventEntity,
      WebhookDeadLetterEntity,
    ],
    synchronize: false,
    logging: config.get<string>('DB_LOGGING') === 'true',
  };
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: buildTypeOrmOptions,
    }),
    TypeOrmModule.forFeature([
      ZaloOaTokenEntity,
      ZaloOauthStateEntity,
      ZaloAccountLinkEntity,
      ZaloMessageLogEntity,
      ZaloLinkVerifyRecordEntity,
      ChatDailyUsageEntity,
      ChatIdempotencyEntity,
      LlmUsageEventEntity,
      LlmSafetyEventEntity,
      StudyReminderJobEntity,
      ScheduledReportClaimEntity,
      WebhookInboundEventEntity,
      WebhookDeadLetterEntity,
    ]),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
