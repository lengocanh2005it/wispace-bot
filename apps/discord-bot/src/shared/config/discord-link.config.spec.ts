import type { ConfigService } from '@nestjs/config';
import {
  readPendingOrganicSkipMs,
  readRewelcomeWindowMs,
} from './discord-link.config';

function buildConfig(value: string | undefined): ConfigService {
  return {
    get: (key: string) =>
      key === 'DISCORD_REWELCOME_WINDOW_MS' ? value : undefined,
  } as unknown as ConfigService;
}

function buildPendingConfig(value: string | undefined): ConfigService {
  return {
    get: (key: string) =>
      key === 'DISCORD_LINK_PENDING_ORGANIC_SKIP_MS' ? value : undefined,
  } as unknown as ConfigService;
}

describe('readRewelcomeWindowMs (#137)', () => {
  it('falls back to 24h when the env var is unset', () => {
    expect(readRewelcomeWindowMs(buildConfig(undefined))).toBe(86_400_000);
  });

  it('parses a valid positive value', () => {
    expect(readRewelcomeWindowMs(buildConfig('3600000'))).toBe(3_600_000);
  });

  it('falls back to 24h for NaN / zero / negative values (never suppresses re-welcomes forever)', () => {
    expect(readRewelcomeWindowMs(buildConfig('not-a-number'))).toBe(86_400_000);
    expect(readRewelcomeWindowMs(buildConfig('0'))).toBe(86_400_000);
    expect(readRewelcomeWindowMs(buildConfig('-5'))).toBe(86_400_000);
  });
});

describe('readPendingOrganicSkipMs (#137 item 4)', () => {
  it('falls back to 120s when unset or invalid', () => {
    expect(readPendingOrganicSkipMs(buildPendingConfig(undefined))).toBe(
      120_000,
    );
    expect(readPendingOrganicSkipMs(buildPendingConfig('nope'))).toBe(120_000);
  });

  it('parses a valid positive value', () => {
    expect(readPendingOrganicSkipMs(buildPendingConfig('60000'))).toBe(60_000);
  });
});
