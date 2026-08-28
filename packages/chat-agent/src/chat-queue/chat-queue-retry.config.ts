export const DEFAULT_FLUSH_RETRY_DELAY_MS = 5_000;
export const DEFAULT_FLUSH_MAX_RETRIES = 3;
const MAX_FLUSH_RETRIES = 100;

export interface ChatFlushRetrySettings {
  enabled: boolean;
  delayMs: number;
  maxRetries: number;
}

export interface StringConfigReader {
  get<T = string>(key: string): T | undefined;
}

export function readPositiveNumber(
  raw: string | undefined,
  fallback: number,
): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function readChatFlushRetrySettings(
  configService: StringConfigReader,
): ChatFlushRetrySettings {
  return {
    enabled:
      configService
        .get<string>('CHAT_FLUSH_RETRY_ENABLED')
        ?.trim()
        .toLowerCase() === 'true',
    delayMs: readPositiveNumber(
      configService.get<string>('CHAT_FLUSH_RETRY_DELAY_MS'),
      DEFAULT_FLUSH_RETRY_DELAY_MS,
    ),
    maxRetries: Math.min(
      readPositiveNumber(
        configService.get<string>('CHAT_FLUSH_MAX_RETRIES'),
        DEFAULT_FLUSH_MAX_RETRIES,
      ),
      MAX_FLUSH_RETRIES,
    ),
  };
}
