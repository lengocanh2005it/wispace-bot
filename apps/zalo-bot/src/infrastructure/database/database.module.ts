import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
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
  getTypeOrmOptions as buildSharedOptions,
  SHARED_ENTITIES,
} from '@wispace/database';

/**
 * Connects to the same Postgres DB as `apps/messenger-bot` (Phase 2: shared
 * schema keyed by `(platform, external_user_id)`). Does NOT run/own
 * migrations — see `docs/turborepo-migration-plan.md` Phase 5: only
 * messenger-bot's pipeline is allowed to run `migration:run`.
 */
export function buildTypeOrmOptions(config: ConfigService) {
  const entities = [
    ...SHARED_ENTITIES,
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
    ]),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
