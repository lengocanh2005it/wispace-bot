import type { ConfigService } from '@nestjs/config';

const DEFAULT_APP_TIMEZONE = 'Asia/Ho_Chi_Minh';

/**
 * Single source of truth for the application timezone.
 *
 * Checks (in order):
 * 1. `CHAT_USAGE_TIMEZONE` — canonical env var
 * 2. `LLM_USAGE_TIMEZONE` — legacy alias
 * 3. `STUDY_REMINDER_TIMEZONE` — legacy alias
 * 4. Falls back to `Asia/Ho_Chi_Minh`
 *
 * Prefer setting `CHAT_USAGE_TIMEZONE`; the other two are deprecated.
 */
export function resolveAppTimezone(
  configService: Pick<ConfigService, 'get'>,
): string {
  return (
    configService.get<string>('CHAT_USAGE_TIMEZONE')?.trim() ??
    configService.get<string>('LLM_USAGE_TIMEZONE')?.trim() ??
    configService.get<string>('STUDY_REMINDER_TIMEZONE')?.trim() ??
    DEFAULT_APP_TIMEZONE
  );
}
