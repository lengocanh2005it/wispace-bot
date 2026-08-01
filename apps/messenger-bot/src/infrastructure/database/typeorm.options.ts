import { ConfigService } from '@nestjs/config';
import { DataSourceOptions } from 'typeorm';
import { getTypeOrmOptions as buildSharedOptions, SHARED_ENTITIES } from '@wispace/database';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  LlmSafetyEventEntity,
  LlmUsageEventEntity,
} from '@wispace/chat-metering';
import { ChatQuotaEventEntity } from './entities/chat-quota-event.entity';
import { MessageLogEntity } from './entities/message-log.entity';
import { StudyReminderJobEntity } from './entities/study-reminder-job.entity';
import { UserPlatformMappingEntity } from './entities/user-platform-mapping.entity';
import { UserEntity } from './entities/user.entity';

type EnvSource = ConfigService | NodeJS.ProcessEnv;

export function getTypeOrmOptions(
  source: EnvSource,
  options?: { includeUsers?: boolean },
): DataSourceOptions {
  const entities = [
    ...SHARED_ENTITIES,
    UserPlatformMappingEntity,
    MessageLogEntity,
    ChatDailyUsageEntity,
    ChatQuotaEventEntity,
    LlmUsageEventEntity,
    LlmSafetyEventEntity,
    ChatIdempotencyEntity,
    StudyReminderJobEntity,
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
