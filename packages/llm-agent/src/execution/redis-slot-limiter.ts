import { randomUUID } from 'crypto';
import { errorMessage } from '@wispace/bot-common/masking';
import type { Redis } from 'ioredis';
import { LlmOverloadError, raceAbort } from './bounded-admission';

export interface SlotLogger {
  warn(message: string): void;
}

export interface SlotMetrics {
  incrementCounter(name: string, labels?: Record<string, string>): void;
}

/**
 * Distributed global LLM concurrency slot with owner-safe leases.
 *
 * Each acquired slot has a UUID fencing token. Release is atomic — only
 * the current owner can release its slot; stale releases are harmless no-ops.
 * Acquire uses a Lua script for atomic INCR + PEXPIRE + lease store.
 *
 * Acquisition is bounded and herd-safe (#453): retries use exponentially
 * growing, fully jittered delays (no fixed cadence, so saturated waiters
 * never EVAL in sync), the total wait respects the caller's admission
 * budget (#389), and sustained Redis failures trip an explicit fail-fast
 * (`maxConsecutiveRedisErrors`) instead of burning the whole wait budget
 * against a dead Redis.
 */
const RETRY_BASE_DELAY_MS = 50;
const RETRY_MAX_DELAY_MS = 1000;
const MAX_RETRIES = 200;
const DEFAULT_MAX_CONSECUTIVE_REDIS_ERRORS = 3;
const DEFAULT_LEASE_MS = 60_000;
const LEASE_PREFIX = ':lease:';

// Lua script: atomic acquire — INCR counter, PEXPIRE, store lease UUID
// Returns: 1 if acquired (current <= limit), 0 if limit exceeded, -1 on error
const ACQUIRE_SCRIPT = `
local key = KEYS[1]
local lease_key = KEYS[2]
local limit = tonumber(ARGV[1])
local ttl_ms = tonumber(ARGV[2])
local uuid = ARGV[3]

local current = redis.call('INCR', key)
redis.call('PEXPIRE', key, ttl_ms)

if current <= limit then
  redis.call('SET', lease_key, uuid, 'PX', ttl_ms)
  return 1
else
  redis.call('DECR', key)
  return 0
end
`;

// Lua script: atomic release — check lease UUID, DECR counter if match
// Returns: 1 if released, 0 if lease mismatch (stale), -1 on error
const RELEASE_SCRIPT = `
local key = KEYS[1]
local lease_key = KEYS[2]
local uuid = ARGV[1]

local stored = redis.call('GET', lease_key)
if stored == uuid then
  redis.call('DEL', lease_key)
  local val = redis.call('DECR', key)
  if val < 0 then
    redis.call('SET', key, 0)
  end
  return 1
else
  return 0
end
`;

export async function acquireRedisSlot(
  redis: Redis,
  key: string,
  limit: number,
  logger: SlotLogger,
  options?: {
    metrics?: SlotMetrics;
    signal?: AbortSignal;
    leaseMs?: number;
    maxRetries?: number;
    /** Base delay for the jittered exponential backoff (doubles per attempt, capped). */
    retryDelayMs?: number;
    /** Total acquire budget in ms — caps retry attempts against retryDelayMs (#389). */
    waitBudgetMs?: number;
    /**
     * Fail fast after this many consecutive Redis failures (#453) — a dead
     * Redis rejects with `redis_unavailable` in ~milliseconds instead of
     * burning the whole wait budget. Any successful EVAL resets the counter.
     */
    maxConsecutiveRedisErrors?: number;
  },
): Promise<() => Promise<void>> {
  const {
    metrics,
    signal,
    leaseMs = DEFAULT_LEASE_MS,
    maxRetries = MAX_RETRIES,
    retryDelayMs = RETRY_BASE_DELAY_MS,
    waitBudgetMs,
    maxConsecutiveRedisErrors = DEFAULT_MAX_CONSECUTIVE_REDIS_ERRORS,
  } = options ?? {};
  const uuid = randomUUID();
  const leaseKey = `${key}${LEASE_PREFIX}${uuid}`;
  let sawRedisError = false;
  const acquireCommand = (): Promise<unknown> =>
    redis.eval(
      ACQUIRE_SCRIPT,
      2,
      key,
      leaseKey,
      String(limit),
      String(leaseMs),
      uuid,
    ) as unknown as Promise<unknown>;

  // Reject early if caller already aborted
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const startedAt = Date.now();
  let consecutiveRedisErrors = 0;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Check cancellation between retries
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    // Bounded wait — aligned with the caller's admission budget (#389/#453).
    if (waitBudgetMs !== undefined && Date.now() - startedAt >= waitBudgetMs) {
      break;
    }

    try {
      // Signal-aware: a caller abort or request deadline rejects even when
      // the Redis command itself hangs (#389).
      const result = await raceAbort(acquireCommand, signal);
      // Any Redis response proves reachability — reset the fail-fast counter.
      consecutiveRedisErrors = 0;

      if (result === 1) {
        metrics?.incrementCounter('llm_concurrency_acquired');
        return () =>
          releaseRedisSlot(redis, key, leaseKey, uuid, logger, metrics);
      }

      metrics?.incrementCounter('llm_concurrency_rejected');
    } catch (err) {
      // AbortError from signal abort during redis.eval
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      sawRedisError = true;
      consecutiveRedisErrors += 1;
      logger.warn(`Redis acquire error: ${errorMessage(err)}`);
      metrics?.incrementCounter('llm_concurrency_rejected');
      if (consecutiveRedisErrors >= maxConsecutiveRedisErrors) {
        // Explicit outage policy (#453): fail fast instead of fail late.
        break;
      }
    }

    // Full-jitter exponential backoff — no fixed cadence, so waiting callers
    // never EVAL in sync (#453). Still abort-aware. Skip the trailing sleep
    // when no further attempt can happen (last attempt or budget spent).
    const anotherAttempt =
      attempt + 1 < maxRetries &&
      (waitBudgetMs === undefined || Date.now() - startedAt < waitBudgetMs);
    if (anotherAttempt) {
      const backoffMs = Math.min(
        RETRY_MAX_DELAY_MS,
        retryDelayMs * 2 ** attempt,
      );
      await abortableSleep(Math.random() * backoffMs, signal);
    }
  }

  const reason = sawRedisError ? 'redis_unavailable' : 'global_saturated';
  // Same low-cardinality rejection contract as local admission (#389).
  metrics?.incrementCounter('llm_admission_rejected_total', { reason });
  throw new LlmOverloadError(reason);
}

/**
 * Sleep that rejects early if the provided AbortSignal fires.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

async function releaseRedisSlot(
  redis: Redis,
  key: string,
  leaseKey: string,
  uuid: string,
  logger: SlotLogger,
  metrics?: SlotMetrics,
): Promise<void> {
  try {
    const result = await redis.eval(RELEASE_SCRIPT, 2, key, leaseKey, uuid);

    if (result === 0) {
      // Lease mismatch — stale release, harmless no-op
      metrics?.incrementCounter('llm_concurrency_stale_release');
    } else {
      metrics?.incrementCounter('llm_concurrency_released');
    }
  } catch (err) {
    logger.warn(`Failed to release concurrency slot: ${errorMessage(err)}`);
    metrics?.incrementCounter('llm_concurrency_release_error');
  }
}
