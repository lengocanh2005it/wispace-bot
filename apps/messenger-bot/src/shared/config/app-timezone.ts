import type { ConfigService } from '@nestjs/config';

const DEFAULT_APP_TIMEZONE = 'Asia/Ho_Chi_Minh';

/**
 * Single source of truth for the application timezone.
 *
 * Checks `CHAT_USAGE_TIMEZONE`, falls back to `Asia/Ho_Chi_Minh`.
 */
export function resolveAppTimezone(
  configService: Pick<ConfigService, 'get'>,
): string {
  return (
    configService.get<string>('CHAT_USAGE_TIMEZONE')?.trim() ??
    DEFAULT_APP_TIMEZONE
  );
}
