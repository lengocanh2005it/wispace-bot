import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import type Redis from 'ioredis';
import type { RedisOptions } from 'ioredis';
import {
  REDIS_OPERATION_METRICS_PORT,
  type RedisClientPort,
  type RedisOperationMetricsPort,
} from './redis.client.port';
import {
  RedisCommandTimeoutError,
  RedisConnectTimeoutError,
} from './redis.operation.errors';
import { isPrivateNetworkHost } from '../utils/network-utils';
import { errorMessage } from '../masking/error-message';

const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 2_000;
const DEFAULT_REDIS_CONNECT_TIMEOUT_MS = 5_000;
const MAX_REDIS_TIMEOUT_MS = 60_000;
const REDIS_SOCKET_TIMEOUT_GRACE_MS = 100;

type RedisCommand = Parameters<Redis['sendCommand']>[0];
type RedisCommandStream = Parameters<Redis['sendCommand']>[1];
type DeadlineRedisOptions = RedisOptions & { replyMapping?: 'legacy' };

function readRedisTimeout(
  configService: ConfigService,
  key: string,
  defaultValue: number,
): number {
  const raw = configService.get<string>(key);
  if (raw === undefined || raw === null) {
    return defaultValue;
  }

  if (typeof raw !== 'string') {
    throw new Error(
      `${key} must be an integer between 1 and ${MAX_REDIS_TIMEOUT_MS} milliseconds`,
    );
  }

  const value = raw.trim();
  const parsed = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_REDIS_TIMEOUT_MS
  ) {
    throw new Error(
      `${key} must be an integer between 1 and ${MAX_REDIS_TIMEOUT_MS} milliseconds`,
    );
  }

  return parsed;
}

function hasErrorCode(error: Error, code: string): boolean {
  return (error as Error & { code?: unknown }).code === code;
}

function isCommandTimeout(error: Error): boolean {
  return error.message === 'Command timed out';
}

function isConnectTimeout(error: Error): boolean {
  return (
    hasErrorCode(error, 'ETIMEDOUT') ||
    /^connect ETIMEDOUT(?:\s|$)/.test(error.message)
  );
}

function isConnectionClosed(error: Error): boolean {
  return error.message === 'Connection is closed.';
}

class DeadlineRedis extends IORedis {
  constructor(
    options: DeadlineRedisOptions,
    private readonly metrics?: RedisOperationMetricsPort,
  ) {
    super(options);
  }

  override connect(
    ...args: Parameters<Redis['connect']>
  ): ReturnType<Redis['connect']> {
    let observedConnectTimeout: Error | undefined;
    const captureConnectTimeout = (error: Error) => {
      if (isConnectTimeout(error)) {
        observedConnectTimeout = error;
      }
    };
    this.on('error', captureConnectTimeout);

    return super
      .connect(...args)
      .catch((error: Error) => {
        const timeoutError = isConnectTimeout(error)
          ? error
          : isConnectionClosed(error)
            ? observedConnectTimeout
            : undefined;
        if (!timeoutError) {
          throw error;
        }

        const normalized = new RedisConnectTimeoutError(timeoutError);
        try {
          this.metrics?.incConnectDeadlineExceeded();
        } catch {
          // Metrics are observability only and must never change connection flow.
        }
        throw normalized;
      })
      .finally(() => this.off('error', captureConnectTimeout)) as ReturnType<
      Redis['connect']
    >;
  }

  override sendCommand(
    command: RedisCommand,
    stream?: RedisCommandStream,
  ): unknown {
    const originalReject = command.reject;
    let rejectionHandled = false;
    command.reject = (error: Error) => {
      const normalized = isCommandTimeout(error)
        ? new RedisCommandTimeoutError(command.name, error)
        : isConnectTimeout(error)
          ? new RedisConnectTimeoutError(error)
          : error;

      if (!rejectionHandled) {
        try {
          if (normalized instanceof RedisCommandTimeoutError) {
            this.metrics?.incCommandDeadlineExceeded(normalized.command);
          } else if (normalized instanceof RedisConnectTimeoutError) {
            this.metrics?.incConnectDeadlineExceeded();
          }
        } catch {
          // Metrics are observability only and must never change command flow.
        }
      }
      rejectionHandled = true;
      originalReject(normalized);
    };

    return super.sendCommand(command, stream);
  }
}

@Injectable()
export class RedisService
  implements RedisClientPort, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private enabled = false;
  private readonly commandTimeoutMs: number;
  private readonly connectTimeoutMs: number;

  constructor(
    private readonly configService: ConfigService,
    @Optional()
    @Inject(REDIS_OPERATION_METRICS_PORT)
    private readonly operationMetrics?: RedisOperationMetricsPort,
  ) {
    const raw = this.configService
      .get<string>('REDIS_ENABLED')
      ?.trim()
      .toLowerCase();
    this.enabled = raw === 'true' || raw === '1' || raw === 'yes';
    this.commandTimeoutMs = readRedisTimeout(
      this.configService,
      'REDIS_COMMAND_TIMEOUT_MS',
      DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
    );
    this.connectTimeoutMs = readRedisTimeout(
      this.configService,
      'REDIS_CONNECT_TIMEOUT_MS',
      DEFAULT_REDIS_CONNECT_TIMEOUT_MS,
    );
  }

  isEnabled(): boolean {
    return this.enabled && this.client !== null;
  }

  isConfiguredEnabled(): boolean {
    return this.enabled;
  }

  getHost(): string {
    return this.configService.get<string>('REDIS_HOST')?.trim() || '127.0.0.1';
  }

  getPort(): number {
    const raw = this.configService.get<string>('REDIS_PORT')?.trim();
    return raw ? parseInt(raw, 10) || 6379 : 6379;
  }

  getPassword(): string | undefined {
    return (
      this.configService.get<string>('REDIS_PASSWORD')?.trim() || undefined
    );
  }

  getNativeClient(): Redis | null {
    return this.client;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('Redis disabled (REDIS_ENABLED=false)');
      return;
    }

    let client: Redis | null = null;
    try {
      const redisTlsEnabled = ['true', '1', 'yes'].includes(
        this.configService.get<string>('REDIS_TLS')?.trim().toLowerCase() ?? '',
      );
      const redisCa = this.configService.get<string>('REDIS_CA')?.trim();
      const allowPrivatePlaintext = ['true', '1', 'yes'].includes(
        this.configService
          .get<string>('REDIS_PRIVATE_NETWORK')
          ?.trim()
          .toLowerCase() ?? '',
      );

      if (
        !redisTlsEnabled &&
        !(allowPrivatePlaintext && isPrivateNetworkHost(this.getHost()))
      ) {
        throw new Error(
          'REDIS_TLS=true is required unless REDIS_PRIVATE_NETWORK=true and REDIS_HOST is private/local',
        );
      }

      client = new DeadlineRedis(
        {
          host: this.getHost(),
          port: this.getPort(),
          password: this.getPassword(),
          commandTimeout: this.commandTimeoutMs,
          connectTimeout: this.connectTimeoutMs,
          socketTimeout: this.commandTimeoutMs + REDIS_SOCKET_TIMEOUT_GRACE_MS,
          enableOfflineQueue: false,
          autoResendUnfulfilledCommands: false,
          maxRetriesPerRequest: 0,
          lazyConnect: true,
          ...(redisTlsEnabled
            ? {
                tls: {
                  rejectUnauthorized: true,
                  ...(redisCa ? { ca: redisCa } : {}),
                },
              }
            : {}),
        },
        this.operationMetrics,
      );
      this.client = client;

      await client.connect();
      const pong = await client.ping();
      this.logger.log(
        `Redis connected host=${this.getHost()} port=${this.getPort()} ping=${pong}`,
      );
    } catch (error) {
      if (client) {
        try {
          client.disconnect();
        } catch {
          // Best-effort cleanup after a failed initial connection.
        }
      }
      this.logger.error(`Redis connection failed: ${errorMessage(error)}`);
      this.client = null;
    }
  }

  async ping(): Promise<string> {
    if (!this.client) return 'NO_REDIS';
    return this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) {
      return;
    }

    try {
      await client.quit();
    } catch (error) {
      this.logger.warn(`Redis shutdown failed: ${errorMessage(error)}`);
      client.disconnect();
    }
  }
}
