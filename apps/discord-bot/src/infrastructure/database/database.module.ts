import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSourceOptions } from 'typeorm';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  LlmSafetyEventEntity,
  LlmUsageEventEntity,
} from '@wispace/chat-metering';
import { StudyReminderJobEntity } from '@wispace/study-reminder-shared';
import {
  WebhookDeadLetterEntity,
  ScheduledReportClaimEntity,
  ReportSendJobEntity,
  getPostgresSsl,
} from '@wispace/database';
import { DiscordAccountLinkEntity } from './entities/discord-account-link.entity';
import { DiscordMessageLogEntity } from './entities/discord-message-log.entity';

/**
 * Connects to the same Postgres DB as `apps/messenger-bot` (Phase 2: shared
 * schema keyed by `(platform, external_user_id)`). Does NOT run/own
 * migrations — see `docs/turborepo-migration-plan.md` Phase 5: only
 * messenger-bot's pipeline is allowed to run `migration:run`, to avoid
 * race conditions between bots' CI on the same DB.
 */
function buildTypeOrmOptions(config: ConfigService): DataSourceOptions {
  return {
    type: 'postgres',
    host: config.get<string>('DB_HOST'),
    port: Number(config.get<string>('DB_PORT') ?? 5432),
    username: config.get<string>('DB_USER'),
    password: config.get<string>('DB_PASSWORD'),
    database: config.get<string>('DB_NAME'),
    ssl: getPostgresSsl(config),
    entities: [
      ChatDailyUsageEntity,
      ChatIdempotencyEntity,
      LlmUsageEventEntity,
      LlmSafetyEventEntity,
      DiscordAccountLinkEntity,
      DiscordMessageLogEntity,
      StudyReminderJobEntity,
      WebhookDeadLetterEntity,
      ReportSendJobEntity,
      ScheduledReportClaimEntity,
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
      ChatDailyUsageEntity,
      ChatIdempotencyEntity,
      LlmUsageEventEntity,
      LlmSafetyEventEntity,
      DiscordAccountLinkEntity,
      DiscordMessageLogEntity,
      WebhookDeadLetterEntity,
      ReportSendJobEntity,
      ScheduledReportClaimEntity,
      StudyReminderJobEntity,
    ]),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
