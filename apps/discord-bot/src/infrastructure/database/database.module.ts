import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
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
  NotificationPreferenceService,
  WebActivityService,
  UserNotificationPreferenceEntity,
  PrivacyDataService,
  type PrivacyEntityRegistry,
  UserPlatformMappingEntity,
  DiscordAccountLinkEntity as CanonicalDiscordAccountLinkEntity,
  ZaloAccountLinkEntity,
  LearnerProfileEntity,
  ScheduledReportClaimEntity,
  ReportSendJobEntity,
  WebActivityEntity,
} from '@wispace/database';
import { DiscordAccountLinkEntity } from './entities/discord-account-link.entity';
import { DiscordLinkVerifyRecordEntity } from './entities/discord-link-verify-record.entity';
import { DiscordMessageLogEntity } from './entities/discord-message-log.entity';
import { DiscordOauthStateEntity } from './entities/discord-oauth-state.entity';
import { DiscordWelcomeRecordEntity } from './entities/discord-welcome-record.entity';

export function buildTypeOrmOptions(config: ConfigService) {
  const entities = [
    ...SHARED_ENTITIES,
    ChatDailyUsageEntity,
    ChatIdempotencyEntity,
    LlmUsageEventEntity,
    LlmSafetyEventEntity,
    DiscordLinkVerifyRecordEntity,
    DiscordMessageLogEntity,
    DiscordOauthStateEntity,
    DiscordWelcomeRecordEntity,
    StudyReminderJobEntity,
  ];
  return buildSharedOptions(config, entities);
}

/**
 * The explicit privacy entity targets this app registers (#461).
 *
 * Exported so `scripts/database-privacy-smoke.mjs` verifies the registry the
 * app actually wires, rather than a copy that can drift from it.
 */
export function buildPrivacyEntityRegistry(): PrivacyEntityRegistry {
  return {
    platform: 'discord',
    mappings: {
      messenger: UserPlatformMappingEntity,
      discord: CanonicalDiscordAccountLinkEntity,
      zalo: ZaloAccountLinkEntity,
    },
    scoped: {
      learnerProfile: LearnerProfileEntity,
      studyReminderJob: StudyReminderJobEntity,
      scheduledReportClaim: ScheduledReportClaimEntity,
      reportSendJob: ReportSendJobEntity,
      chatDailyUsage: ChatDailyUsageEntity,
      llmUsageEvent: LlmUsageEventEntity,
      chatIdempotency: ChatIdempotencyEntity,
      webActivity: WebActivityEntity,
      notificationPreference: UserNotificationPreferenceEntity,
    },
    messageLog: DiscordMessageLogEntity,
  };
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
      DiscordOauthStateEntity,
      DiscordWelcomeRecordEntity,
      StudyReminderJobEntity,
      UserNotificationPreferenceEntity,
    ]),
  ],
  providers: [
    DbCircuitBreakerService,
    CanonicalPlatformService,
    NotificationPreferenceService,
    WebActivityService,
    {
      provide: PrivacyDataService,
      useFactory: (dataSource: DataSource) =>
        new PrivacyDataService(dataSource, buildPrivacyEntityRegistry()),
      inject: [DataSource],
    },
  ],
  exports: [
    TypeOrmModule,
    CanonicalPlatformService,
    NotificationPreferenceService,
    WebActivityService,
    PrivacyDataService,
  ],
})
export class DatabaseModule {}
