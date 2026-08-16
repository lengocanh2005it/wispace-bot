import { join } from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { WebhookDeadLetterEntity } from './entities/webhook-dead-letter.entity';
import { WebhookInboundEventEntity } from './entities/webhook-inbound-event.entity';
import { ScheduledReportClaimEntity } from './entities/scheduled-report-claim.entity';
import { ReportSendJobEntity } from './entities/report-send-job.entity';
import { RescheduleConfirmationEntity } from './entities/reschedule-confirmation.entity';
import { CronLeaderLeaseEntity } from './entities/cron-leader-lease.entity';
import { LearnerProfileEntity } from './entities/learner-profile.entity';

export type EntityClass = new (...args: unknown[]) => unknown;

type EnvSource = ConfigService | NodeJS.ProcessEnv;

export function readEnv(source: EnvSource, key: string): string | undefined {
  if (source instanceof ConfigService) {
    return source.get<string>(key);
  }
  return source[key];
}

/**
 * TLS policy — enforced independent of NODE_ENV: any host that is not
 * localhost/a private IPv4 address requires DB_SSL=true (startup + migration
 * CLI both fail via this shared builder). Hostnames cannot be IP-classified,
 * so `DB_ALLOW_INSECURE_HOSTS` (comma-separated) is the only explicit
 * plaintext exception for private-network hosts that are not IP literals
 * (e.g. Docker-internal `postgres`). TLS connections always verify the peer.
 */
export function getPostgresSsl(
  source: EnvSource,
): false | { rejectUnauthorized: true; ca?: string } {
  if (readEnv(source, 'DB_SSL') !== 'true') {
    const host = readEnv(source, 'DB_HOST')?.trim() ?? '';
    if (
      !isPrivateNetworkHost(host) &&
      !isInsecureHostAllowlisted(source, host)
    ) {
      throw new Error(
        'DB_SSL=true is required for database hosts outside a private/local network (or list the host in DB_ALLOW_INSECURE_HOSTS)',
      );
    }
    return false;
  }

  const ca = readEnv(source, 'DB_SSL_CA')?.trim();
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

function isInsecureHostAllowlisted(source: EnvSource, host: string): boolean {
  const raw = readEnv(source, 'DB_ALLOW_INSECURE_HOSTS') ?? '';
  const normalizedHost = host.toLowerCase();
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .some((entry) => entry !== '' && entry === normalizedHost);
}

function isPrivateNetworkHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1'
  ) {
    return true;
  }

  const octets = normalized.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }

  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

/** Shared entities used by all bots — import and spread into each bot's entity list. */
export const SHARED_ENTITIES: EntityClass[] = [
  WebhookDeadLetterEntity,
  WebhookInboundEventEntity,
  ScheduledReportClaimEntity,
  ReportSendJobEntity,
  RescheduleConfirmationEntity,
  CronLeaderLeaseEntity,
  LearnerProfileEntity,
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
