import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  createCircuitBreakerDataSourceFactory,
  DbCircuitBreakerService,
  CanonicalPlatformService,
  NotificationPreferenceService,
  WebActivityService,
  WebActivityEntity,
  UserNotificationPreferenceEntity,
  PrivacyDataService,
  type PrivacyEntityRegistry,
  UserPlatformMappingEntity as CanonicalUserPlatformMappingEntity,
  DiscordAccountLinkEntity,
  ZaloAccountLinkEntity,
  LearnerProfileEntity,
  LearnerScheduledReportClaimEntity as CanonicalLearnerScheduledReportClaimEntity,
  PrivacyCleanupJobStore,
} from '@wispace/database';
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
  providers: [
    DbCircuitBreakerService,
    CanonicalPlatformService,
    NotificationPreferenceService,
    WebActivityService,
    {
      provide: PrivacyCleanupJobStore,
      useFactory: (dataSource: DataSource) =>
        new PrivacyCleanupJobStore(dataSource),
      inject: [DataSource],
    },
    {
      provide: PrivacyDataService,
      useFactory: (
        dataSource: DataSource,
        cleanupJobs: PrivacyCleanupJobStore,
      ) =>
        new PrivacyDataService(
          dataSource,
          buildPrivacyEntityRegistry(),
          cleanupJobs,
        ),
      inject: [DataSource, PrivacyCleanupJobStore],
    },
  ],
  exports: [
    TypeOrmModule,
    CanonicalPlatformService,
    NotificationPreferenceService,
    WebActivityService,
    PrivacyCleanupJobStore,
    PrivacyDataService,
  ],
})
export class DatabaseModule {}
