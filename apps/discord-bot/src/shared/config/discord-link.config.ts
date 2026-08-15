import type { ConfigService } from '@nestjs/config';

const DEFAULT_REWELCOME_WINDOW_MS = 86_400_000;

/**
 * Welcome-DM dedupe window (#137 items 2+4): a linked user who re-joins (or
 * joins while the OAuth callback is still running) is not welcomed again
 * within this window. Falls back to 24h when unset or non-numeric — never
 * NaN (a NaN window would suppress re-welcomes forever).
 */
export function readRewelcomeWindowMs(configService: ConfigService): number {
  const raw = configService.get<string>('DISCORD_REWELCOME_WINDOW_MS');
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_REWELCOME_WINDOW_MS;
}
