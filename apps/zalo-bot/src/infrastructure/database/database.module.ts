import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ZaloOaTokenEntity } from './entities/zalo-oa-token.entity';
import { ZaloOauthStateEntity } from './entities/zalo-oauth-state.entity';
import { ZaloAccountLinkEntity } from './entities/zalo-account-link.entity';
import { ZaloLinkVerifyRecordEntity } from './entities/zalo-link-verify-record.entity';
import { ZaloWelcomeRecordEntity } from './entities/zalo-welcome-record.entity';
import { ZaloMessageLogEntity } from './entities/zalo-message-log.entity';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  LlmUsageEventEntity,
  LlmSafetyEventEntity,
} from '@wispace/chat-metering/adapters';
import { StudyReminderJobEntity } from '@wispace/study-reminder-shared/adapters';
import {
  getTypeOrmOptions as buildSharedOptions,
  SHARED_ENTITIES,
  buildPlatformDatabaseProviders,
  createCircuitBreakerDataSourceFactory,
  PLATFORM_DATABASE_EXPORTS,
  UserNotificationPreferenceEntity,
  type PrivacyEntityRegistry,
  UserPlatformMappingEntity,
  DiscordAccountLinkEntity,
  ZaloAccountLinkEntity as CanonicalZaloAccountLinkEntity,
  LearnerProfileEntity,
  LearnerScheduledReportClaimEntity,
  ScheduledReportClaimEntity,
  ReportSendJobEntity,
  WebActivityEntity,
  RescheduleConfirmationAttemptEntity,
} from '@wispace/database';
import { BotMetricsService } from '@wispace/bot-metrics';

export function buildTypeOrmOptions(config: ConfigService) {
  const entities = [
    ...SHARED_ENTITIES,
    ZaloOaTokenEntity,
    ZaloOauthStateEntity,
    ZaloMessageLogEntity,
    ZaloLinkVerifyRecordEntity,
    ZaloWelcomeRecordEntity,
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
      rescheduleConfirmationAttempt: RescheduleConfirmationAttemptEntity,
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
      ZaloWelcomeRecordEntity,
      ChatDailyUsageEntity,
      ChatIdempotencyEntity,
      LlmUsageEventEntity,
      LlmSafetyEventEntity,
      StudyReminderJobEntity,
      UserNotificationPreferenceEntity,
    ]),
  ],
  providers: buildPlatformDatabaseProviders({
    circuitBreakerMetrics: BotMetricsService,
    privacyEntityRegistry: buildPrivacyEntityRegistry,
  }),
  exports: PLATFORM_DATABASE_EXPORTS,
})
export class DatabaseModule {}
