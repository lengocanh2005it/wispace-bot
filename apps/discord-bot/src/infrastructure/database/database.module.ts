import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  LlmSafetyEventEntity,
  LlmUsageEventEntity,
} from '@wispace/chat-metering';
import { StudyReminderJobEntity } from '@wispace/study-reminder-shared';
import {
  getTypeOrmOptions as buildSharedOptions,
  SHARED_ENTITIES,
} from '@wispace/database';
import { DiscordAccountLinkEntity } from './entities/discord-account-link.entity';
import { DiscordLinkVerifyRecordEntity } from './entities/discord-link-verify-record.entity';
import { DiscordMessageLogEntity } from './entities/discord-message-log.entity';
import { DiscordWelcomeRecordEntity } from './entities/discord-welcome-record.entity';

/**
 * Connects to the same Postgres DB as `apps/messenger-bot` (Phase 2: shared
 * schema keyed by `(platform, external_user_id)`). Does NOT run/own
 * migrations — see `docs/turborepo-migration-plan.md` Phase 5: only
 * messenger-bot's pipeline is allowed to run `migration:run`, to avoid
 * race conditions between bots' CI on the same DB.
 */
function buildTypeOrmOptions(config: ConfigService) {
  const entities = [
    ...SHARED_ENTITIES,
    ChatDailyUsageEntity,
    ChatIdempotencyEntity,
    LlmUsageEventEntity,
    LlmSafetyEventEntity,
    DiscordAccountLinkEntity,
    DiscordLinkVerifyRecordEntity,
    DiscordMessageLogEntity,
    DiscordWelcomeRecordEntity,
    StudyReminderJobEntity,
  ];
  return buildSharedOptions(config, entities);
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: buildTypeOrmOptions,
    }),
    TypeOrmModule.forFeature([
      ...SHARED_ENTITIES,
      ChatDailyUsageEntity,
      ChatIdempotencyEntity,
      LlmUsageEventEntity,
      LlmSafetyEventEntity,
      DiscordAccountLinkEntity,
      DiscordLinkVerifyRecordEntity,
      DiscordMessageLogEntity,
      DiscordWelcomeRecordEntity,
      StudyReminderJobEntity,
    ]),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
