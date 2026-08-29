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
  createCircuitBreakerDataSourceFactory,
  DbCircuitBreakerService,
  CanonicalPlatformService,
  NotificationPreferenceService,
  WebActivityService,
  UserNotificationPreferenceEntity,
} from '@wispace/database';

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
  ],
  exports: [
    TypeOrmModule,
    CanonicalPlatformService,
    NotificationPreferenceService,
    WebActivityService,
  ],
})
export class DatabaseModule {}
