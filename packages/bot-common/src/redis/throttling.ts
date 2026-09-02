import { Throttle } from '@nestjs/throttler';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import type { ConfigService } from '@nestjs/config';
import type { RedisService } from './redis.service';
import { RedisThrottlerStorage } from './redis-throttler-storage';

export interface ThrottleConfig {
  limit: number;
  ttlMs: number;
}

const DEFAULT_WEBHOOK_LIMIT = 120;
const DEFAULT_WEBHOOK_TTL_MS = 60_000;
const DEFAULT_GLOBAL_LIMIT = 20;
const DEFAULT_GLOBAL_TTL_MS = 60_000;

export function readWebhookThrottleConfig(
  get: (key: string) => string | undefined,
): ThrottleConfig {
  return {
    limit: readPositiveInt(
      get('WEBHOOK_RATE_LIMIT_PER_MINUTE'),
      DEFAULT_WEBHOOK_LIMIT,
    ),
    ttlMs: readPositiveInt(
      get('WEBHOOK_RATE_LIMIT_TTL_MS'),
      DEFAULT_WEBHOOK_TTL_MS,
    ),
  };
}

function readGlobalThrottleConfig(
  get: (key: string) => string | undefined,
): ThrottleConfig {
  return {
    limit: readPositiveInt(get('THROTTLE_DEFAULT_LIMIT'), DEFAULT_GLOBAL_LIMIT),
    ttlMs: readPositiveInt(
      get('THROTTLE_DEFAULT_TTL_MS'),
      DEFAULT_GLOBAL_TTL_MS,
    ),
  };
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Route-level throttle values are resolved per request from loaded env config. */
export function WebhookThrottle(): MethodDecorator & ClassDecorator {
  return Throttle({
    default: {
      limit: () => readWebhookThrottleConfig((key) => process.env[key]).limit,
      ttl: () => readWebhookThrottleConfig((key) => process.env[key]).ttlMs,
    },
  });
}

/**
 * Read nginx X-Real-IP (forged-safe — nginx overwrites it) instead of
 * enabling Express trust proxy, which would change req.ip semantics for
 * every middleware in the app. X-Forwarded-For is deliberately ignored
 * because nginx appends to it, letting clients forge the leftmost entry.
 * Falls back to the TCP connection address (fail closed). Exported for
 * direct unit testing — inline into the lambda once a second call site
 * appears.
 *
 * Ponytail: 3 lines of logic, no subclass, no trust proxy.
 */
export function throttleTracker(req: Record<string, any>): string {
  return req.headers?.['x-real-ip'] || req.socket?.remoteAddress;
}

// AC5: Webhook routes (Discord/Zalo) apply @WebhookThrottle() which
// overrides the global throttle with its own limit (120 req/60s).
// The getTracker change here does NOT affect webhook redelivery.
export function createBotThrottlerOptions(
  configService: ConfigService,
  redisService: RedisService,
): ThrottlerModuleOptions {
  const config = readGlobalThrottleConfig((key) =>
    configService.get<string>(key),
  );

  // AC6: 20 req/min was sized for a single global bucket shared by all
  // clients. Now genuinely per-client, revisit if legitimate OAuth
  // linking bursts (e.g. start-of-term class onboardings) hit the cap.
  return {
    throttlers: [{ ttl: config.ttlMs, limit: config.limit }],
    storage: new RedisThrottlerStorage(redisService),
    getTracker: (req) => throttleTracker(req),
  };
}
