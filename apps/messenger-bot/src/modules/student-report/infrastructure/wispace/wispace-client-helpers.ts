import { InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  WispaceApiClientConfig,
  WispaceClientMetrics,
} from '@wispace/wispace-client';

export function buildWispaceClientConfig(
  configService: ConfigService,
  urlKey: string,
  fallbackUrl?: string,
  metrics?: WispaceClientMetrics,
): WispaceApiClientConfig {
  const url = configService.get<string>(urlKey)?.trim() ?? fallbackUrl;
  if (!url) {
    throw new InternalServerErrorException(`${urlKey} must be set in .env`);
  }

  return {
    url,
    internalKey: getWispaceInternalKey(configService),
    maxRetries: readWispacePositiveInt(
      configService,
      'WISPACE_API_MAX_RETRIES',
      3,
    ),
    baseDelayMs: readWispacePositiveInt(
      configService,
      'WISPACE_API_RETRY_BASE_DELAY_MS',
      500,
    ),
    metrics,
  };
}

export function getWispaceInternalKey(configService: ConfigService): string {
  const key = configService.get<string>('WISPACE_INTERNAL_KEY')?.trim();
  if (!key) {
    throw new InternalServerErrorException(
      'WISPACE_INTERNAL_KEY must be set in .env',
    );
  }

  return key;
}

export function readWispacePositiveInt(
  configService: ConfigService,
  key: string,
  defaultValue: number,
): number {
  const raw = configService.get<string>(key)?.trim();
  if (!raw) return defaultValue;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : defaultValue;
}
