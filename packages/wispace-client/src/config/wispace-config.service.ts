import type {
  WispaceApiClientConfig,
  WispaceClientMetrics,
} from '../clients/wispace-client-types';
import type { PrecreateExerciseClientConfig } from '../types/precreate-exercise.types';
import type { WispaceLinkStatusClientConfig } from '../types/link-status.types';
import type { WispaceIdHeader } from '../utils/wispace-headers';
import {
  validateUpstreamUrl,
  buildUpstreamUrlPolicy,
} from '../utils/upstream-url.utils';
import { DEFAULT_KEEP_ALIVE_POOL_SIZE } from '../utils/keep-alive-agent';

export type WispaceConfigGetter = (key: string) => string | undefined;

/**
 * Wispace API client config — shared by Discord and Zalo (consolidation of
 * their near-identical per-app config services, including the required
 * study-reminder horizon/lead-time getters).
 */
export class WispaceConfigService {
  constructor(
    private readonly getConfig: WispaceConfigGetter,
    private readonly metrics?: WispaceClientMetrics,
  ) {}

  buildGoalsClientConfig(): WispaceApiClientConfig {
    return this.buildClientConfig(
      'WISPACE_API_USER_GOALS_URL',
      'https://backend.aihubproduction.com/api/User/goals',
    );
  }

  buildTaskScoreClientConfig(): WispaceApiClientConfig {
    return this.buildClientConfig(
      'WISPACE_API_TASK_SCORE_URL',
      'https://backend.aihubproduction.com/api/TaskScoreAverage',
    );
  }

  buildCalendarClientConfig(): WispaceApiClientConfig {
    return this.buildClientConfig('WISPACE_API_USER_CALENDAR_URL');
  }

  buildPrecreateExerciseClientConfig(): PrecreateExerciseClientConfig {
    const config = this.buildClientConfig('WISPACE_API_PRECREATE_EXERCISE_URL');
    return {
      url: config.url,
      internalKey: config.internalKey,
      requestTimeoutMs: this.readRequiredPositiveInt(
        'WISPACE_API_PRECREATE_EXERCISE_TIMEOUT_MS',
      ),
      poolSize: config.poolSize,
      metrics: this.metrics,
    };
  }

  buildLinkStatusClientConfig(
    header: WispaceIdHeader,
  ): WispaceLinkStatusClientConfig {
    const url = this.getConfig('WISPACE_API_LINK_STATUS_URL')?.trim();
    const production =
      this.getConfig('NODE_ENV')?.trim() === 'production' ||
      ['true', '1', 'yes'].includes(
        this.getConfig('ENFORCE_PROD_CHAT_QUOTA')?.trim().toLowerCase() ?? '',
      );
    if (!url && production) {
      throw new Error(
        'WISPACE_API_LINK_STATUS_URL must be set in production — link ownership reconciliation is required',
      );
    }
    const disabled =
      this.getConfig('WISPACE_LINK_STATUS_ENABLED')?.trim().toLowerCase() ===
      'false';
    if (disabled && production) {
      throw new Error(
        'WISPACE_LINK_STATUS_ENABLED=false is not allowed in production',
      );
    }
    if (!url) {
      return { header, enabled: false };
    }

    validateUpstreamUrl(
      url,
      buildUpstreamUrlPolicy('WISPACE_API_LINK_STATUS_URL', {
        get: this.getConfig,
      }),
    );

    return {
      url,
      internalKey: this.getInternalKey(),
      header,
      enabled: !disabled,
      maxRetries: this.readPositiveInt('WISPACE_API_MAX_RETRIES', 2),
      baseDelayMs: this.readPositiveInt('WISPACE_API_RETRY_BASE_DELAY_MS', 500),
      requestTimeoutMs: this.readPositiveInt(
        'WISPACE_API_LINK_STATUS_TIMEOUT_MS',
        5_000,
      ),
      poolSize: this.getPoolSize(),
      metrics: this.metrics,
    };
  }

  getTimezone(): string {
    return (
      this.getConfig('STUDY_REMINDER_TIMEZONE')?.trim() ?? 'Asia/Ho_Chi_Minh'
    );
  }

  getMinLeadMinutes(): number {
    const raw = this.getConfig('STUDY_REMINDER_MIN_LEAD_MINUTES')?.trim();
    if (!raw) {
      throw new Error('STUDY_REMINDER_MIN_LEAD_MINUTES must be set in .env');
    }

    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        'STUDY_REMINDER_MIN_LEAD_MINUTES must be a positive number in .env',
      );
    }

    return value;
  }

  getSyncHorizonHours(): number {
    const raw = this.getConfig('STUDY_REMINDER_SYNC_HORIZON_HOURS')?.trim();
    if (!raw) {
      throw new Error('STUDY_REMINDER_SYNC_HORIZON_HOURS must be set in .env');
    }

    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        'STUDY_REMINDER_SYNC_HORIZON_HOURS must be a positive number in .env',
      );
    }

    return value;
  }

  private buildClientConfig(
    urlKey: string,
    fallbackUrl?: string,
  ): WispaceApiClientConfig {
    const url = this.getConfig(urlKey)?.trim() ?? fallbackUrl;
    if (!url) {
      throw new Error(`${urlKey} must be set in .env`);
    }

    validateUpstreamUrl(
      url,
      buildUpstreamUrlPolicy(urlKey, { get: this.getConfig }),
    );

    return {
      url,
      internalKey: this.getInternalKey(),
      maxRetries: this.readPositiveInt('WISPACE_API_MAX_RETRIES', 3),
      baseDelayMs: this.readPositiveInt('WISPACE_API_RETRY_BASE_DELAY_MS', 500),
      poolSize: this.getPoolSize(),
      metrics: this.metrics,
    };
  }

  private getInternalKey(): string {
    const key = this.getConfig('WISPACE_INTERNAL_KEY')?.trim();
    if (!key) {
      throw new Error('WISPACE_INTERNAL_KEY must be set in .env');
    }

    return key;
  }

  /**
   * Keep-alive connections per host (#567). `readPositiveInt` lets an
   * explicit `0` through, which is not a usable pool — clamp it (and any
   * other non-positive) back to the default so the config never lies.
   */
  private getPoolSize(): number {
    return (
      this.readPositiveInt(
        'WISPACE_HTTP_POOL_SIZE',
        DEFAULT_KEEP_ALIVE_POOL_SIZE,
      ) || DEFAULT_KEEP_ALIVE_POOL_SIZE
    );
  }

  private readPositiveInt(key: string, defaultValue: number): number {
    const raw = this.getConfig(key)?.trim();
    if (!raw) return defaultValue;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : defaultValue;
  }

  private readRequiredPositiveInt(key: string): number {
    const raw = this.getConfig(key)?.trim();
    if (!raw) {
      throw new Error(`${key} must be set in .env`);
    }

    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${key} must be a positive number in .env`);
    }

    return Math.floor(value);
  }
}
