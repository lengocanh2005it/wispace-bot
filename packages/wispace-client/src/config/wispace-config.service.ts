import type { WispaceApiClientConfig } from '../clients/wispace-client-types';
import type { PrecreateExerciseClientConfig } from '../types/precreate-exercise.types';
import {
  validateUpstreamUrl,
  buildUpstreamUrlPolicy,
} from '../utils/upstream-url.utils';

export type WispaceConfigGetter = (key: string) => string | undefined;

/**
 * Wispace API client config — shared by Discord and Zalo (consolidation of
 * their near-identical per-app config services, including the required
 * study-reminder horizon/lead-time getters).
 */
export class WispaceConfigService {
  constructor(private readonly getConfig: WispaceConfigGetter) {}

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
    };
  }

  private getInternalKey(): string {
    const key = this.getConfig('WISPACE_INTERNAL_KEY')?.trim();
    if (!key) {
      throw new Error('WISPACE_INTERNAL_KEY must be set in .env');
    }

    return key;
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
