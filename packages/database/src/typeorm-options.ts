import { join } from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { WebhookDeadLetterEntity } from './entities/webhook-dead-letter.entity';
import { WebhookInboundEventEntity } from './entities/webhook-inbound-event.entity';
import { ScheduledReportClaimEntity } from './entities/scheduled-report-claim.entity';
import { ReportSendJobEntity } from './entities/report-send-job.entity';
import { RescheduleConfirmationEntity } from './entities/reschedule-confirmation.entity';
import { CronLeaderLeaseEntity } from './entities/cron-leader-lease.entity';

export type EntityClass = new (...args: unknown[]) => unknown;

type EnvSource = ConfigService | NodeJS.ProcessEnv;

export function readEnv(source: EnvSource, key: string): string | undefined {
  if (source instanceof ConfigService) {
    return source.get<string>(key);
  }
  return source[key];
}

export function getPostgresSsl(
  source: EnvSource,
): false | { rejectUnauthorized: true; ca?: string } {
  if (readEnv(source, 'DB_SSL') !== 'true') {
    return false;
  }

  const ca = readEnv(source, 'DB_SSL_CA')?.trim();
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

/** Shared entities used by all bots — import and spread into each bot's entity list. */
export const SHARED_ENTITIES: EntityClass[] = [
  WebhookDeadLetterEntity,
  WebhookInboundEventEntity,
  ScheduledReportClaimEntity,
  ReportSendJobEntity,
  RescheduleConfirmationEntity,
  CronLeaderLeaseEntity,
];

/**
 * Build TypeORM options for a bot.
 * @param source  ConfigService (runtime) or process.env (CLI)
 * @param entities  Bot-specific entity list (spread SHARED_ENTITIES first, then local)
 */
export function getTypeOrmOptions(
  source: EnvSource,
  entities: EntityClass[],
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
    ssl: getPostgresSsl(source),
    poolSize,
    extra: {
      pool: {
        idleTimeoutMillis: poolIdleTimeoutMs,
        connectionTimeoutMillis: poolConnectionTimeoutMs,
      },
    },
    entities,
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
    synchronize: false,
    logging: readEnv(source, 'DB_LOGGING') === 'true',
  };
}

/** Build a CLI-ready DataSource from process.env. */
export function buildCliDataSource(entities: EntityClass[]): DataSource {
  return new DataSource(getTypeOrmOptions(process.env, entities));
}
