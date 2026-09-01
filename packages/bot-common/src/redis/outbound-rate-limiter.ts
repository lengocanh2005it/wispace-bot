import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import type { Platform } from '@wispace/contracts';
import { errorMessage, maskExternalId, maskExternalIdInText } from '../masking';
import { RedisService } from './redis.service';

export type OutboundRateLimitDecision =
  | 'allowed'
  | 'limited'
  | 'store_unavailable'
  | 'disabled';

export interface OutboundRateLimitInput {
  platform: Platform;
  externalUserId: string;
  userId?: number | null;
  units?: number;
}

export interface OutboundRateLimitResult {
  allowed: boolean;
  outcome: OutboundRateLimitDecision;
  reason?: 'cap_exceeded' | 'batch_too_large' | 'redis_unavailable';
  remaining?: number;
}

const DEFAULT_MAX_MESSAGES = 30;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const MIN_MAX_MESSAGES = 1;
const MAX_MAX_MESSAGES = 1_000;
const MIN_WINDOW_MS = 1_000;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

const ADMIT_SCRIPT = `
local clock = redis.call('TIME')
local now_ms = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local window_ms = tonumber(ARGV[1])
local units = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local cutoff = now_ms - window_ms

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
local current = redis.call('ZCARD', KEYS[1])
if current + units > limit then
  if current > 0 then
    redis.call('EXPIRE', KEYS[1], math.ceil(window_ms / 1000) + 1)
  end
  return {0, current}
end

for i = 1, units do
  redis.call('ZADD', KEYS[1], now_ms, ARGV[4] .. ':' .. i)
end
redis.call('EXPIRE', KEYS[1], math.ceil(window_ms / 1000) + 1)
return {1, current + units}
`;

export class OutboundRateLimitConfig {
  constructor(
    readonly enabled: boolean,
    readonly maxMessages: number,
    readonly windowMs: number,
    readonly nodeEnv: string,
  ) {}
}

/**
 * Cross-platform outbound burst backstop. Redis is the production source of
 * truth; the bounded in-memory path exists only for local development/tests.
 */
@Injectable()
export class OutboundRateLimiter implements OnModuleInit {
  private readonly logger = new Logger(OutboundRateLimiter.name);
  private readonly config: OutboundRateLimitConfig;
  private readonly memoryBuckets = new Map<string, number[]>();

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {
    const get = (key: string): string | undefined =>
      this.configService.get<string>(key);
    const nodeEnv =
      get('NODE_ENV')?.trim().toLowerCase() ||
      process.env.NODE_ENV?.trim().toLowerCase() ||
      'development';

    this.config = new OutboundRateLimitConfig(
      readBoolean(
        'OUTBOUND_RATE_LIMIT_ENABLED',
        get('OUTBOUND_RATE_LIMIT_ENABLED'),
        true,
      ),
      readBoundedInt(
        'OUTBOUND_RATE_LIMIT_MAX_MESSAGES',
        get('OUTBOUND_RATE_LIMIT_MAX_MESSAGES'),
        DEFAULT_MAX_MESSAGES,
        MIN_MAX_MESSAGES,
        MAX_MAX_MESSAGES,
      ),
      readBoundedInt(
        'OUTBOUND_RATE_LIMIT_WINDOW_MS',
        get('OUTBOUND_RATE_LIMIT_WINDOW_MS'),
        DEFAULT_WINDOW_MS,
        MIN_WINDOW_MS,
        MAX_WINDOW_MS,
      ),
      nodeEnv,
    );
  }

  async onModuleInit(): Promise<void> {
    if (
      this.config.enabled &&
      this.config.nodeEnv === 'production' &&
      !this.redisService.isEnabled()
    ) {
      throw new Error(
        'Redis is required for outbound rate limiting in production',
      );
    }
  }

  getConfig(): OutboundRateLimitConfig {
    return this.config;
  }

  async admit(input: OutboundRateLimitInput): Promise<OutboundRateLimitResult> {
    if (!this.config.enabled) {
      return { allowed: true, outcome: 'disabled' };
    }

    const units = input.units ?? 1;
    if (!Number.isSafeInteger(units) || units < 1) {
      throw new Error('Outbound rate-limit units must be a positive integer');
    }

    if (units > this.config.maxMessages) {
      return this.limited(input, 'batch_too_large');
    }

    const key = this.bucketKey(input);
    const redis = this.redisService.isEnabled()
      ? this.redisService.getNativeClient()
      : null;

    if (redis) {
      try {
        return await this.fromRedisResult(input, key, units, redis);
      } catch (error) {
        this.logger.error(
          `Outbound limiter Redis error externalUserId=${maskExternalId(
            input.externalUserId,
          )}: ${maskExternalIdInText(
            errorMessage(error),
            input.externalUserId,
          )}`,
        );
        return {
          allowed: true,
          outcome: 'store_unavailable',
          reason: 'redis_unavailable',
        };
      }
    }

    if (this.redisService.isConfiguredEnabled()) {
      this.logger.error(
        `Outbound limiter Redis unavailable externalUserId=${maskExternalId(
          input.externalUserId,
        )}`,
      );
      return {
        allowed: true,
        outcome: 'store_unavailable',
        reason: 'redis_unavailable',
      };
    }

    return this.fromMemory(input, key, units);
  }

  private async fromRedisResult(
    input: OutboundRateLimitInput,
    key: string,
    units: number,
    redis: Redis,
  ): Promise<OutboundRateLimitResult> {
    const raw = await redis.eval(
      ADMIT_SCRIPT,
      1,
      key,
      String(this.config.windowMs),
      String(units),
      String(this.config.maxMessages),
      randomUUID(),
    );
    const allowed = Number(Array.isArray(raw) ? raw[0] : NaN) === 1;
    const current = Number(Array.isArray(raw) ? raw[1] : NaN);
    if (!Number.isFinite(current)) {
      throw new Error('Invalid outbound limiter Redis response');
    }
    if (!allowed) {
      return this.limited(
        input,
        'cap_exceeded',
        Math.max(0, this.config.maxMessages - current),
      );
    }
    return {
      allowed: true,
      outcome: 'allowed',
      remaining: Math.max(0, this.config.maxMessages - current),
    };
  }

  private fromMemory(
    input: OutboundRateLimitInput,
    key: string,
    units: number,
  ): OutboundRateLimitResult {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;
    const bucket = (this.memoryBuckets.get(key) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );

    if (bucket.length + units > this.config.maxMessages) {
      return this.limited(
        input,
        'cap_exceeded',
        Math.max(0, this.config.maxMessages - bucket.length),
      );
    }

    // ponytail: bounded O(n) local bucket; Redis is authoritative in production.
    for (let i = 0; i < units; i += 1) bucket.push(now);
    this.memoryBuckets.set(key, bucket);
    return {
      allowed: true,
      outcome: 'allowed',
      remaining: this.config.maxMessages - bucket.length,
    };
  }

  private limited(
    input: OutboundRateLimitInput,
    reason: 'cap_exceeded' | 'batch_too_large',
    remaining?: number,
  ): OutboundRateLimitResult {
    this.logger.warn(
      `Outbound message rate limit exceeded platform=${input.platform} externalUserId=${maskExternalId(
        input.externalUserId,
      )} reason=${reason}`,
    );
    return {
      allowed: false,
      outcome: 'limited',
      reason,
      ...(remaining === undefined ? {} : { remaining }),
    };
  }

  private bucketKey(input: OutboundRateLimitInput): string {
    const identity =
      input.userId !== undefined && input.userId !== null
        ? `user:${input.userId}`
        : `external:${input.platform}:${input.externalUserId}`;
    const digest = createHash('sha256').update(identity).digest('hex');
    return `outbound-rate:v1:${digest}`;
  }
}

function readBoolean(
  name: string,
  raw: string | undefined,
  fallback: boolean,
): boolean {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean`);
}

function readBoundedInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}
