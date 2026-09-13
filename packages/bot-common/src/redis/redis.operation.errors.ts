export const REDIS_COMMAND_TIMEOUT_CODE = 'REDIS_COMMAND_TIMEOUT';
export const REDIS_CONNECT_TIMEOUT_CODE = 'REDIS_CONNECT_TIMEOUT';

function normalizeCommandName(command: string): string {
  const normalized = command.trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,31}$/.test(normalized) ? normalized : 'unknown';
}

export class RedisCommandTimeoutError extends Error {
  readonly code = REDIS_COMMAND_TIMEOUT_CODE;
  readonly command: string;
  declare readonly cause: Error;

  constructor(command: string, cause: Error) {
    super(`Redis command ${normalizeCommandName(command)} timed out`, {
      cause,
    });
    this.name = RedisCommandTimeoutError.name;
    this.command = normalizeCommandName(command);
  }
}

export class RedisConnectTimeoutError extends Error {
  readonly code = REDIS_CONNECT_TIMEOUT_CODE;
  declare readonly cause: Error;

  constructor(cause: Error) {
    super('Redis connection timed out', { cause });
    this.name = RedisConnectTimeoutError.name;
  }
}
