import { ConfigService } from '@nestjs/config';
import { DataSourceOptions } from 'typeorm';
import {
  getTypeOrmOptions as buildSharedOptions,
  SHARED_ENTITIES,
  WebActivityEntity,
} from '@wispace/database';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  LlmSafetyEventEntity,
  LlmUsageEventEntity,
} from '@wispace/chat-metering';
import { ChatQuotaEventEntity } from './entities/chat-quota-event.entity';
import { MessageLogEntity } from './entities/message-log.entity';
import { StudyReminderJobEntity } from '@wispace/study-reminder-shared';
import { UserPlatformMappingEntity } from './entities/user-platform-mapping.entity';
import { UserEntity } from './entities/user.entity';
import { MessengerLinkVerifyRecordEntity } from './entities/messenger-link-verify-record.entity';

type EnvSource = ConfigService | NodeJS.ProcessEnv;

export function getTypeOrmOptions(
  source: EnvSource,
  options?: { includeUsers?: boolean },
): DataSourceOptions {
  const entities = [
    ...SHARED_ENTITIES,
    UserPlatformMappingEntity,
    MessageLogEntity,
    MessengerLinkVerifyRecordEntity,
    ChatDailyUsageEntity,
    ChatQuotaEventEntity,
    LlmUsageEventEntity,
    LlmSafetyEventEntity,
    ChatIdempotencyEntity,
    StudyReminderJobEntity,
    WebActivityEntity,
    ...(options?.includeUsers ? [UserEntity] : []),
  ];
  return buildSharedOptions(source, entities);
}

export function getAppTypeOrmOptions(
  config: ConfigService,
): DataSourceOptions & { migrationsRun?: boolean } {
  return {
    ...getTypeOrmOptions(config, { includeUsers: true }),
    migrationsRun: config.get<string>('DB_MIGRATIONS_RUN') === 'true',
  };
}
