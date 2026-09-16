import { z } from 'zod';
import { errorMessage } from '@wispace/bot-common/masking';
import { WispaceApiError } from '../errors/wispace-api.error';
import {
  isWispaceRetryable,
  createCircuitBreaker,
  computeCircuitBreakerTimeout,
  withRetry,
} from '../utils/with-retry';
import type { CircuitBreaker } from '../utils/with-retry';
import { mergeWithTimeout } from '../utils/abort-signal.utils';
import { fetchWispaceJson } from '../utils/fetch-wispace-json';
import { keepAliveFetch } from '../utils/keep-alive-agent';
import { validateShape } from '../utils/validate-shape';
import type {
  ReengagementCandidatesResult,
  ReengagementClientConfig,
  ReengagementDiscordPayload,
  ReengagementMarkSentInput,
  ReengagementMarkSentResult,
  ReengagementPayload,
  ReengagementPlatform,
} from '../types/reengagement.types';
import {
  NOOP_WISPACE_LOGGER,
  type WispaceClientLogger,
} from './wispace-client-types';

const DEFAULT_DAYS = 11;
const DEFAULT_PLATFORM: ReengagementPlatform = 'discord';
const MAX_LIMIT = 200;

interface CandidateQuery {
  platform?: ReengagementPlatform;
  days?: number;
  limit: number;
}

const nullableString = z.union([z.string(), z.null()]);
const jsonObject = z.record(z.string(), z.unknown());
const dateString = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'ISO date string');

const candidateSchema = z.object({
  userId: z.string().min(1),
  discordId: nullableString.optional(),
  psid: nullableString.optional(),
  email: nullableString.optional(),
  userName: z.string().min(1),
  platform: z.enum(['discord', 'messenger']),
  lastActiveAt: dateString,
  daysInactive: z.number().nonnegative(),
  variant: z.enum(['a', 'b']),
});

const candidatesSchema = z.object({
  totalCandidates: z.number().nonnegative(),
  candidates: z.array(candidateSchema),
});

const payloadSchema = z.object({
  variant: z.enum(['a', 'b']),
  period: z.string().min(1),
  is_fallback: z.boolean(),
  summary: jsonObject,
  discord_payload: z.object({
    embeds: z.array(jsonObject),
    components: z.array(jsonObject),
  }),
});

const markSentSchema = z.object({
  success: z.boolean(),
  logId: nullableString.optional(),
});

export class ReengagementApiClient {
  private readonly breaker: CircuitBreaker<
    [fn: () => Promise<unknown>],
    unknown
  >;

  constructor(
    private readonly config: ReengagementClientConfig,
    private readonly logger: WispaceClientLogger = NOOP_WISPACE_LOGGER,
  ) {
    const maxRetries = this.config.maxRetries ?? 3;
    const reqTimeout = this.config.requestTimeoutMs ?? 10_000;
    const circuitTimeout = computeCircuitBreakerTimeout(reqTimeout, maxRetries);

    this.breaker = createCircuitBreaker(
      (fn: () => Promise<unknown>) =>
        withRetry(fn, {
          maxRetries,
          baseDelayMs: this.config.baseDelayMs ?? 500,
          shouldRetry: isWispaceRetryable,
          onRetry: (attempt, max, err) =>
            this.logger.warn(
              `Reengagement API retry ${attempt}/${max}: ${errorMessage(err)}`,
            ),
        }),
      { timeout: circuitTimeout },
    );
  }

  async getCandidates(
    query: CandidateQuery,
    options?: { signal?: AbortSignal },
  ): Promise<ReengagementCandidatesResult> {
    const params = new URLSearchParams({
      platform: query.platform ?? DEFAULT_PLATFORM,
      days: String(query.days ?? DEFAULT_DAYS),
      limit: String(clampLimit(query.limit)),
    });
    const url = `${this.config.url}/candidates?${params.toString()}`;

    const raw = await this.fetchWithRetry(
      url,
      { method: 'GET' },
      options?.signal,
      'Reengagement/candidates',
    );

    return this.normalizeCandidates(raw);
  }

  async getPayload(
    userId: string,
    options?: { signal?: AbortSignal; platform?: ReengagementPlatform },
  ): Promise<ReengagementPayload> {
    const trimmed = requireUserId(userId);
    const params = new URLSearchParams({
      platform: options?.platform ?? DEFAULT_PLATFORM,
    });
    const url = `${this.config.url}/payload/${encodeURIComponent(trimmed)}?${params.toString()}`;

    const raw = await this.fetchWithRetry(
      url,
      { method: 'GET' },
      options?.signal,
      'Reengagement/payload',
      trimmed,
    );

    return this.normalizePayload(raw);
  }

  async markSent(
    input: ReengagementMarkSentInput,
    options?: { signal?: AbortSignal },
  ): Promise<ReengagementMarkSentResult> {
    const trimmed = requireUserId(input.userId);
    // Suppression log is single-shot — never retried (idempotency is not
    // guaranteed upstream), same policy as PrecreateExerciseApiClient.
    const url = `${this.config.url}/mark-sent`;
    const body = JSON.stringify({
      user_id: trimmed,
      platform: input.platform ?? DEFAULT_PLATFORM,
      ...(input.daysInactive !== undefined
        ? { days_inactive: input.daysInactive }
        : {}),
      variant: input.variant,
      status: input.status,
      ...(input.messageId !== undefined ? { message_id: input.messageId } : {}),
    });

    const response = await keepAliveFetch(
      url,
      {
        method: 'POST',
        headers: this.buildBotHeaders(),
        body,
        signal: mergeWithTimeout(options?.signal, this.requestTimeoutMs()),
      },
      { poolSize: this.config.poolSize, logger: this.logger },
    );

    if (!response.ok) {
      throw new WispaceApiError(
        `Reengagement mark-sent API failed: HTTP ${response.status} ${response.statusText}`,
        response.status,
        trimmed,
        'Reengagement/mark-sent',
      );
    }

    return this.normalizeMarkSent(
      await this.parseJson(response, 'Reengagement/mark-sent'),
    );
  }

  private async fetchWithRetry(
    url: string,
    init: { method: 'GET' },
    signal: AbortSignal | undefined,
    endpoint: string,
    externalId?: string,
  ): Promise<unknown> {
    const call = () =>
      this.fetchJsonOnce(url, init, signal, endpoint, externalId);
    return this.breaker.fire(call) as Promise<unknown>;
  }

  private async fetchJsonOnce(
    url: string,
    init: { method: 'GET' },
    signal: AbortSignal | undefined,
    endpoint: string,
    externalId?: string,
  ): Promise<unknown> {
    const response = await keepAliveFetch(
      url,
      {
        method: init.method,
        headers: this.buildBotHeaders(),
        signal: mergeWithTimeout(signal, this.requestTimeoutMs()),
      },
      { poolSize: this.config.poolSize, logger: this.logger },
    );

    if (!response.ok) {
      throw new WispaceApiError(
        `${endpoint} API failed: HTTP ${response.status} ${response.statusText}`,
        response.status,
        externalId ?? '',
        endpoint,
      );
    }

    return this.parseJson(response, endpoint);
  }

  private async parseJson(
    response: Response,
    endpoint: string,
  ): Promise<unknown> {
    try {
      return await fetchWispaceJson(response);
    } catch (err) {
      if (err instanceof WispaceApiError) throw err;
      throw new Error(`${endpoint} API returned malformed JSON`);
    }
  }

  private buildBotHeaders(): Record<string, string> {
    if (!this.config.internalKey.trim()) {
      throw new Error(
        'WISPACE internal key is required for WISPACE API requests',
      );
    }
    // Bot-level endpoints — no platform identity header: these calls act for
    // the bot itself, not a specific learner.
    return {
      'X-Internal-Key': this.config.internalKey,
      Accept: 'application/json',
    };
  }

  private requestTimeoutMs(): number {
    return this.config.requestTimeoutMs ?? 10_000;
  }

  private normalizeCandidates(raw: unknown): ReengagementCandidatesResult {
    const root = validateShape(candidatesSchema, raw);
    const candidates = root.candidates.map((c) => ({
      userId: c.userId,
      discordId: c.discordId ?? null,
      psid: c.psid ?? null,
      email: c.email ?? null,
      userName: c.userName,
      platform: c.platform,
      lastActiveAt: c.lastActiveAt,
      daysInactive: c.daysInactive,
      variant: c.variant,
    }));

    return { totalCandidates: root.totalCandidates, candidates };
  }

  private normalizePayload(raw: unknown): ReengagementPayload {
    const root = validateShape(payloadSchema, raw);

    return {
      variant: root.variant,
      period: root.period,
      is_fallback: root.is_fallback,
      summary: root.summary,
      discord_payload: {
        embeds: root.discord_payload
          .embeds as ReengagementDiscordPayload['embeds'],
        components: root.discord_payload
          .components as ReengagementDiscordPayload['components'],
      },
    };
  }

  private normalizeMarkSent(raw: unknown): ReengagementMarkSentResult {
    const root = validateShape(markSentSchema, raw);
    return {
      success: root.success,
      logId: root.logId ?? null,
    };
  }
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT);
}

function requireUserId(userId: string): string {
  const trimmed = userId.trim();
  if (!trimmed) {
    throw new Error('userId is required for re-engagement API requests');
  }
  return trimmed;
}
