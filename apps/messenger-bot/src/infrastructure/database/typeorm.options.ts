import { join } from 'path';
import { DataSourceOptions } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  LlmSafetyEventEntity,
  LlmUsageEventEntity,
} from '@wispace/chat-metering';
import { ChatQuotaEventEntity } from './entities/chat-quota-event.entity';
import { MessageLogEntity } from './entities/message-log.entity';
import { ScheduledReportClaimEntity } from './entities/scheduled-report-claim.entity';
import { WebhookDeadLetterEntity } from './entities/webhook-dead-letter.entity';
import { ReportSendJobEntity } from './entities/report-send-job.entity';
import { StudyReminderJobEntity } from './entities/study-reminder-job.entity';
import { UserPlatformMappingEntity } from './entities/user-platform-mapping.entity';
import { UserEntity } from './entities/user.entity';

type EnvSource = ConfigService | NodeJS.ProcessEnv;

function readEnv(source: EnvSource, key: string): string | undefined {
  if (source instanceof ConfigService) {
    return source.get<string>(key);
  }

  return source[key];
}

export function getTypeOrmOptions(
  source: EnvSource,
  options?: { includeUsers?: boolean },
): DataSourceOptions {
  const poolSize = Number(readEnv(source, 'DB_POOL_SIZE') ?? 10);
  const poolIdleTimeoutMs = Number(
    readEnv(source, 'DB_POOL_IDLE_TIMEOUT_MS') ?? 30_000,
  );
  const poolConnectionTimeoutMs = Number(
    readEnv(source, 'DB_POOL_CONNECTION_TIMEOUT_MS') ?? 5_000,
  );

  return {
    type: 'postgres',
    host: readEnv(source, 'DB_HOST'),
    port: Number(readEnv(source, 'DB_PORT') ?? 5432),
    username: readEnv(source, 'DB_USER'),
    password: readEnv(source, 'DB_PASSWORD'),
    database: readEnv(source, 'DB_NAME'),
    ssl:
      readEnv(source, 'DB_SSL') === 'true'
        ? { rejectUnauthorized: false }
        : false,
    poolSize,
    extra: {
      pool: {
        idleTimeoutMillis: poolIdleTimeoutMs,
        connectionTimeoutMillis: poolConnectionTimeoutMs,
      },
    },
    entities: [
      UserPlatformMappingEntity,
      MessageLogEntity,
      WebhookDeadLetterEntity,
      ScheduledReportClaimEntity,
      ReportSendJobEntity,
      ChatDailyUsageEntity,
      ChatQuotaEventEntity,
      LlmUsageEventEntity,
      LlmSafetyEventEntity,
      ChatIdempotencyEntity,
      StudyReminderJobEntity,
      ...(options?.includeUsers ? [UserEntity] : []),
    ],
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
    synchronize: false,
    logging: readEnv(source, 'DB_LOGGING') === 'true',
  };
}

export function getAppTypeOrmOptions(
  config: ConfigService,
): DataSourceOptions & { migrationsRun?: boolean } {
  return {
    ...getTypeOrmOptions(config, { includeUsers: true }),
    migrationsRun: config.get<string>('DB_MIGRATIONS_RUN') === 'true',
  };
}
