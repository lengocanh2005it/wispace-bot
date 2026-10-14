import { applyDecorators, SetMetadata } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
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
const WEBHOOK_THROTTLE_METADATA = 'wispace:throttler:webhook';

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

/** Marks a route for the webhook throttle profile configured through ConfigService. */
export function WebhookThrottle(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(WEBHOOK_THROTTLE_METADATA, true),
    SkipThrottle({ default: true }),
    Throttle({ webhook: {} }),
  );
}

function isWebhookThrottleRoute(context: ExecutionContext): boolean {
  return (
    Reflect.getMetadata(WEBHOOK_THROTTLE_METADATA, context.getHandler()) ===
      true ||
    Reflect.getMetadata(WEBHOOK_THROTTLE_METADATA, context.getClass()) === true
  );
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
interface ThrottleTrackerRequest {
  headers?: Record<string, unknown>;
  socket?: { remoteAddress?: unknown };
}

export function throttleTracker(
  req: ThrottleTrackerRequest,
): string | undefined {
  const headerIp = req.headers?.['x-real-ip'];
  if (typeof headerIp === 'string' && headerIp) {
    return headerIp;
  }

  const remoteAddress = req.socket?.remoteAddress;
  return typeof remoteAddress === 'string' && remoteAddress
    ? remoteAddress
    : undefined;
}

// AC5: Messenger/Zalo webhook routes use the named @WebhookThrottle profile
// (120 req/60s by default), while other routes use the global profile.
// The getTracker change here does NOT affect webhook redelivery.
export function createBotThrottlerOptions(
  configService: ConfigService,
  redisService: RedisService,
): ThrottlerModuleOptions {
  const config = readGlobalThrottleConfig((key) =>
    configService.get<string>(key),
  );
  const webhookConfig = readWebhookThrottleConfig((key) =>
    configService.get<string>(key),
  );

  // AC6: 20 req/min was sized for a single global bucket shared by all
  // clients. Now genuinely per-client, revisit if legitimate OAuth
  // linking bursts (e.g. start-of-term class onboardings) hit the cap.
  return {
    throttlers: [
      { ttl: config.ttlMs, limit: config.limit },
      {
        name: 'webhook',
        ttl: webhookConfig.ttlMs,
        limit: webhookConfig.limit,
        skipIf: (context) => !isWebhookThrottleRoute(context),
      },
    ],
    storage: new RedisThrottlerStorage(redisService),
    getTracker: (req) => throttleTracker(req) ?? 'unknown',
  };
}
