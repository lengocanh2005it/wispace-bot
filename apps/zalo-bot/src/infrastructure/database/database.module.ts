import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
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
  createCircuitBreakerDataSourceFactory,
  DbCircuitBreakerService,
  CanonicalPlatformService,
  NotificationPreferenceService,
  WebActivityService,
  UserNotificationPreferenceEntity,
  PrivacyDataService,
  type PrivacyEntityRegistry,
  UserPlatformMappingEntity,
  DiscordAccountLinkEntity,
  ZaloAccountLinkEntity as CanonicalZaloAccountLinkEntity,
  LearnerProfileEntity,
  LearnerScheduledReportClaimEntity,
  ScheduledReportClaimEntity,
  ReportSendJobEntity,
  WebActivityEntity,
} from '@wispace/database';

export function buildTypeOrmOptions(config: ConfigService) {
  const entities = [
    ...SHARED_ENTITIES,
    ZaloOaTokenEntity,
    ZaloOauthStateEntity,
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

/**
 * The explicit privacy entity targets this app registers (#461).
 *
 * Exported so `scripts/database-privacy-smoke.mjs` verifies the registry the
 * app actually wires, rather than a copy that can drift from it.
 */
export function buildPrivacyEntityRegistry(): PrivacyEntityRegistry {
  return {
    platform: 'zalo',
    mappings: {
      messenger: UserPlatformMappingEntity,
      discord: DiscordAccountLinkEntity,
      zalo: CanonicalZaloAccountLinkEntity,
    },
    scoped: {
      learnerProfile: LearnerProfileEntity,
      studyReminderJob: StudyReminderJobEntity,
      scheduledReportClaim: ScheduledReportClaimEntity,
      learnerScheduledReportClaim: LearnerScheduledReportClaimEntity,
      reportSendJob: ReportSendJobEntity,
      chatDailyUsage: ChatDailyUsageEntity,
      llmUsageEvent: LlmUsageEventEntity,
      chatIdempotency: ChatIdempotencyEntity,
      webActivity: WebActivityEntity,
      notificationPreference: UserNotificationPreferenceEntity,
    },
    messageLog: ZaloMessageLogEntity,
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
