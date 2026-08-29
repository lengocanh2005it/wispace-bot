import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  createCircuitBreakerDataSourceFactory,
  DbCircuitBreakerService,
  CanonicalPlatformService,
  NotificationPreferenceService,
  WebActivityService,
  WebActivityEntity,
  UserNotificationPreferenceEntity,
} from '@wispace/database';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  MessageLogEntity,
  ScheduledReportClaimEntity,
  ReportSendJobEntity,
  StudyReminderJobEntity,
  UserEntity,
  UserPlatformMappingEntity,
} from './entities';
import { getAppTypeOrmOptions } from './typeorm.options';

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
  ],
  exports: [
    TypeOrmModule,
    CanonicalPlatformService,
    NotificationPreferenceService,
    WebActivityService,
  ],
})
export class DatabaseModule {}
