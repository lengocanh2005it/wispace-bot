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
} from '@wispace/database';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  LlmUsageEventEntity,
  MessageLogEntity,
  ScheduledReportClaimEntity,
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
