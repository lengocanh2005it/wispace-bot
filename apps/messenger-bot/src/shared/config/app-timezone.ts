import type { ConfigService } from '@nestjs/config';
import {
  APP_TIMEZONE_ENV_KEY,
  DEFAULT_TIMEZONE,
  LEGACY_TIMEZONE_ENV_KEYS,
} from '@wispace/contracts';

/**
 * Keys that count as "a learner timezone is configured at all", checked by the
 * study-reminder startup validation. `APP_TIMEZONE` leads; the legacy keys stay
 * so an environment that has not yet adopted `APP_TIMEZONE` still passes.
 */
export const APP_TIMEZONE_ENV_KEYS = [
  APP_TIMEZONE_ENV_KEY,
  LEGACY_TIMEZONE_ENV_KEYS.chatUsage,
  LEGACY_TIMEZONE_ENV_KEYS.llmUsage,
  LEGACY_TIMEZONE_ENV_KEYS.studyReminder,
] as const;

/**
 * Single source of truth for the application timezone.
 *
 * Checks `APP_TIMEZONE` → `CHAT_USAGE_TIMEZONE` → `LLM_USAGE_TIMEZONE` →
 * `STUDY_REMINDER_TIMEZONE`, then falls back to `Asia/Ho_Chi_Minh`.
 */
export function resolveAppTimezone(
  configService: Pick<ConfigService, 'get'>,
): string {
  for (const key of APP_TIMEZONE_ENV_KEYS) {
    const value = configService.get<string>(key)?.trim();
    if (value) return value;
  }
  return DEFAULT_TIMEZONE;
}
