import type { ConfigService } from '@nestjs/config';

const DEFAULT_REWELCOME_WINDOW_MS = 86_400_000;
const DEFAULT_PENDING_ORGANIC_SKIP_MS = 120_000;
const DEFAULT_WELCOME_CLAIM_MS = 60_000;

/**
 * Welcome-DM dedupe window (#137 items 2+4): a linked user who re-joins (or
 * joins while the OAuth callback is still running) is not welcomed again
 * within this window. Falls back to 24h when unset or non-numeric — never
 * NaN (a NaN window would suppress re-welcomes forever).
 */
export function readRewelcomeWindowMs(configService: ConfigService): number {
  return readPositiveConfigMs(
    configService,
    'DISCORD_REWELCOME_WINDOW_MS',
    DEFAULT_REWELCOME_WINDOW_MS,
  );
}

/**
 * Atomic welcome claim lease (#159): `tryClaimWelcome` reserves the welcome
 * for this long while the DM is being sent. A concurrent OAuth callback /
 * `guildMemberAdd` loses the claim, and a claim whose sender crashed or
 * failed becomes claimable again after the lease expires (retryable).
 */
export function readWelcomeClaimMs(configService: ConfigService): number {
  return readPositiveConfigMs(
    configService,
    'DISCORD_WELCOME_CLAIM_MS',
    DEFAULT_WELCOME_CLAIM_MS,
  );
}

/**
 * Freshness window for the join-during-callback race (#137 item 4): when a
 * `guildMemberAdd` lands before the mapping commit but a verify intent is
 * pending (callback in flight), the organic welcome is skipped — the callback
 * owns the welcome. Stale pending intents (callback failed) still get the
 * organic welcome so no one is left without one.
 */
export function readPendingOrganicSkipMs(configService: ConfigService): number {
  return readPositiveConfigMs(
    configService,
    'DISCORD_LINK_PENDING_ORGANIC_SKIP_MS',
    DEFAULT_PENDING_ORGANIC_SKIP_MS,
  );
}

function readPositiveConfigMs(
  configService: ConfigService,
  key: string,
  fallback: number,
): number {
  const raw = configService.get<string>(key);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
