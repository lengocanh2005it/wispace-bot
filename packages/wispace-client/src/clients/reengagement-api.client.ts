import { errorMessage } from '@wispace/bot-common/masking';
import { WispaceApiError } from '../errors/wispace-api.error';
import {
  isWispaceRetryable,
  createCircuitBreaker,
  computeCircuitBreakerTimeout,
} from '../utils/with-retry';
import type { CircuitBreaker } from '../utils/with-retry';
import { withRetry } from '../utils/with-retry';
import { mergeWithTimeout } from '../utils/abort-signal.utils';
import { fetchWispaceJson } from '../utils/fetch-wispace-json';
import { keepAliveFetch } from '../utils/keep-alive-agent';
import {
  validateShape,
  isNonEmptyString,
  isNonNegativeNumber,
  isDateString,
} from '../utils/validate-shape';
import type {
  ReengagementCandidatesResult,
  ReengagementClientConfig,
  ReengagementDiscordPayload,
  ReengagementMarkSentInput,
  ReengagementMarkSentResult,
  ReengagementPayload,
  ReengagementPlatform,
  ReengagementVariant,
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

function isVariant(value: unknown): value is ReengagementVariant {
  return value === 'a' || value === 'b';
}

function isPlatform(value: unknown): value is ReengagementPlatform {
  return value === 'discord' || value === 'messenger';
}

function isArrayOfObjects(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => item !== null && typeof item === 'object')
  );
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

export class ReengagementApiClient {
  private readonly breaker: CircuitBreaker<any[], unknown>;

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
      days_inactive: input.daysInactive,
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
    const root = validateShape<{
      totalCandidates: number;
      candidates: unknown;
    }>(raw, [
      {
        name: 'totalCandidates',
        validate: isNonNegativeNumber,
        expected: 'non-negative number',
      },
      { name: 'candidates', validate: Array.isArray, expected: 'array' },
    ]);

    const candidates = (root.candidates as unknown[]).map((item) => {
      const c = validateShape<{
        userId: string;
        discordId: unknown;
        psid: unknown;
        email: unknown;
        userName: string;
        platform: string;
        lastActiveAt: string;
        daysInactive: number;
        variant: string;
      }>(item, [
        {
          name: 'userId',
          validate: isNonEmptyString,
          expected: 'non-empty string',
        },
        {
          name: 'discordId',
          validate: isNullableString,
          expected: 'string or null',
          required: false,
        },
        {
          name: 'psid',
          validate: isNullableString,
          expected: 'string or null',
          required: false,
        },
        {
          name: 'email',
          validate: isNullableString,
          expected: 'string or null',
          required: false,
        },
        {
          name: 'userName',
          validate: isNonEmptyString,
          expected: 'non-empty string',
        },
        {
          name: 'platform',
          validate: isPlatform,
          expected: "'discord' | 'messenger'",
        },
        {
          name: 'lastActiveAt',
          validate: isDateString,
          expected: 'ISO date string',
        },
        {
          name: 'daysInactive',
          validate: isNonNegativeNumber,
          expected: 'non-negative number',
        },
        { name: 'variant', validate: isVariant, expected: "'a' | 'b'" },
      ]);
      return {
        userId: c.userId,
        discordId: (c.discordId ?? null) as string | null,
        psid: (c.psid ?? null) as string | null,
        email: (c.email ?? null) as string | null,
        userName: c.userName,
        platform: c.platform as ReengagementPlatform,
        lastActiveAt: c.lastActiveAt,
        daysInactive: c.daysInactive,
        variant: c.variant as ReengagementVariant,
      };
    });

    return { totalCandidates: root.totalCandidates, candidates };
  }

  private normalizePayload(raw: unknown): ReengagementPayload {
    const root = validateShape<{
      variant: string;
      period: string;
      is_fallback: boolean;
      summary: unknown;
      discord_payload: unknown;
    }>(raw, [
      { name: 'variant', validate: isVariant, expected: "'a' | 'b'" },
      {
        name: 'period',
        validate: isNonEmptyString,
        expected: 'non-empty string',
      },
      {
        name: 'is_fallback',
        validate: (v) => typeof v === 'boolean',
        expected: 'boolean',
      },
      {
        name: 'summary',
        validate: (v) => v !== null && typeof v === 'object',
        expected: 'object',
      },
      {
        name: 'discord_payload',
        validate: (v) => v !== null && typeof v === 'object',
        expected: 'object',
      },
    ]);

    const discord = root.discord_payload as Record<string, unknown>;
    const embeds = discord.embeds;
    const components = discord.components;
    if (!isArrayOfObjects(embeds) || !isArrayOfObjects(components)) {
      throw new Error(
        'Reengagement payload API returned invalid discord_payload arrays',
      );
    }

    return {
      variant: root.variant as ReengagementVariant,
      period: root.period,
      is_fallback: root.is_fallback,
      summary: root.summary as Record<string, unknown>,
      discord_payload: {
        embeds: embeds as ReengagementDiscordPayload['embeds'],
        components: components as ReengagementDiscordPayload['components'],
      },
    };
  }

  private normalizeMarkSent(raw: unknown): ReengagementMarkSentResult {
    const root = validateShape<{ success: boolean; logId: unknown }>(raw, [
      {
        name: 'success',
        validate: (v) => typeof v === 'boolean',
        expected: 'boolean',
      },
      {
        name: 'logId',
        validate: isNullableString,
        expected: 'string or null',
        required: false,
      },
    ]);
    return {
      success: root.success,
      logId: (root.logId ?? null) as string | null,
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
