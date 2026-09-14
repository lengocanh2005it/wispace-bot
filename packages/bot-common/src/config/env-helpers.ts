import type { ConfigService } from '@nestjs/config';

type ConfigReader = Pick<ConfigService, 'get'>;

/** Shared tolerant readers used by scheduled workers. */
export function readEnvBoolean(
  config: ConfigReader,
  key: string,
  fallback: boolean,
): boolean {
  const value = config.get<unknown>(key);
  const raw = value == null ? '' : String(value).trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return fallback;
}

export function readEnvPositiveInt(
  config: ConfigReader,
  key: string,
  fallback: number,
): number {
  const rawValue = config.get<unknown>(key);
  const raw = rawValue == null ? '' : String(rawValue).trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
