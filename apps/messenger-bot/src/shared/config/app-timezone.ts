import type { ConfigService } from '@nestjs/config';

const DEFAULT_APP_TIMEZONE = 'Asia/Ho_Chi_Minh';

export const APP_TIMEZONE_ENV_KEYS = [
  'CHAT_USAGE_TIMEZONE',
  'LLM_USAGE_TIMEZONE',
  'STUDY_REMINDER_TIMEZONE',
] as const;

/**
 * Single source of truth for the application timezone.
 *
 * Checks `CHAT_USAGE_TIMEZONE` → `LLM_USAGE_TIMEZONE` →
 * `STUDY_REMINDER_TIMEZONE`, then falls back to `Asia/Ho_Chi_Minh`.
 */
export function resolveAppTimezone(
  configService: Pick<ConfigService, 'get'>,
): string {
  for (const key of APP_TIMEZONE_ENV_KEYS) {
    const value = configService.get<string>(key)?.trim();
    if (value) return value;
  }
  return DEFAULT_APP_TIMEZONE;
}
