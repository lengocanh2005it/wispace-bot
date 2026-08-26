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
  createCircuitBreakerDataSourceFactory,
  DbCircuitBreakerService,
  CanonicalPlatformService,
  UserNotificationPreferenceEntity,
} from '@wispace/database';
import { DiscordAccountLinkEntity } from './entities/discord-account-link.entity';
import { DiscordLinkVerifyRecordEntity } from './entities/discord-link-verify-record.entity';
import { DiscordMessageLogEntity } from './entities/discord-message-log.entity';
import { DiscordWelcomeRecordEntity } from './entities/discord-welcome-record.entity';

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
      dataSourceFactory: createCircuitBreakerDataSourceFactory(),
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
      UserNotificationPreferenceEntity,
    ]),
  ],
  providers: [DbCircuitBreakerService, CanonicalPlatformService],
  exports: [TypeOrmModule, CanonicalPlatformService],
})
export class DatabaseModule {}
