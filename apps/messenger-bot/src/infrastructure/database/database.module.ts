import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  buildPlatformDatabaseProviders,
  createCircuitBreakerDataSourceFactory,
  PLATFORM_DATABASE_EXPORTS,
  UserNotificationPreferenceEntity,
  WebActivityEntity,
  type PrivacyEntityRegistry,
  UserPlatformMappingEntity as CanonicalUserPlatformMappingEntity,
  DiscordAccountLinkEntity,
  ZaloAccountLinkEntity,
  LearnerProfileEntity,
  LearnerScheduledReportClaimEntity as CanonicalLearnerScheduledReportClaimEntity,
} from '@wispace/database';
import { BotMetricsService } from '@wispace/bot-metrics';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  LlmUsageEventEntity,
  MessageLogEntity,
  ScheduledReportClaimEntity,
  LearnerScheduledReportClaimEntity,
  ReportSendJobEntity,
  StudyReminderJobEntity,
  UserEntity,
  UserPlatformMappingEntity,
} from './entities';
import { getAppTypeOrmOptions } from './typeorm.options';

/**
 * The explicit privacy entity targets this app registers (#461).
 *
 * Exported so `scripts/database-privacy-smoke.mjs` verifies the registry the
 * app actually wires, rather than a copy that can drift from it.
 */
export function buildPrivacyEntityRegistry(): PrivacyEntityRegistry {
  return {
    platform: 'messenger',
    mappings: {
      messenger: CanonicalUserPlatformMappingEntity,
      discord: DiscordAccountLinkEntity,
      zalo: ZaloAccountLinkEntity,
    },
    scoped: {
      learnerProfile: LearnerProfileEntity,
      studyReminderJob: StudyReminderJobEntity,
      scheduledReportClaim: ScheduledReportClaimEntity,
      learnerScheduledReportClaim: CanonicalLearnerScheduledReportClaimEntity,
      reportSendJob: ReportSendJobEntity,
      chatDailyUsage: ChatDailyUsageEntity,
      llmUsageEvent: LlmUsageEventEntity,
      chatIdempotency: ChatIdempotencyEntity,
      webActivity: WebActivityEntity,
      notificationPreference: UserNotificationPreferenceEntity,
    },
    messageLog: MessageLogEntity,
  };
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => getAppTypeOrmOptions(config),
      dataSourceFactory: createCircuitBreakerDataSourceFactory(),
    }),
    TypeOrmModule.forFeature([
      UserPlatformMappingEntity,
      MessageLogEntity,
      ScheduledReportClaimEntity,
      LearnerScheduledReportClaimEntity,
      ReportSendJobEntity,
      ChatDailyUsageEntity,
      ChatIdempotencyEntity,
      StudyReminderJobEntity,
      UserEntity,
      UserNotificationPreferenceEntity,
      WebActivityEntity,
    ]),
  ],
  providers: buildPlatformDatabaseProviders({
    circuitBreakerMetrics: BotMetricsService,
    privacyEntityRegistry: buildPrivacyEntityRegistry,
  }),
  exports: PLATFORM_DATABASE_EXPORTS,
})
export class DatabaseModule {}
