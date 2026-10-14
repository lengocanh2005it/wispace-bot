import { readEnvPositiveInt } from '@wispace/bot-common/config';

/**
 * Send deadline for one Discord attempt, in milliseconds.
 *
 * Defaults to 15s — the effective behaviour of `RESTOptions.timeout` before
 * #1509 made it explicit. ADR-0053 explains why the deadline lives with the
 * transport adapter rather than in the client's `rest.timeout`, and why the
 * SDK's own timeout is kept above it.
 */
export const DEFAULT_DISCORD_SEND_TIMEOUT_MS = 15_000;

export const DISCORD_SEND_TIMEOUT_KEY = 'DISCORD_SEND_TIMEOUT_MS';

/**
 * The SDK aborts through a private controller with no reason, so a request
 * must never be bounded by two timers that could both fire (ADR-0053). The
 * client's `rest.timeout` therefore stays this far above the adapter's own
 * deadline, leaving ours the only one that can end a send.
 */
export const DISCORD_REST_TIMEOUT_MULTIPLIER = 2;

/** Reads the configured send deadline, falling back to the pre-#1509 value. */
export function resolveDiscordSendTimeoutMs(config: {
  get: <T>(key: string) => T | undefined;
}): number {
  return readEnvPositiveInt(
    config,
    DISCORD_SEND_TIMEOUT_KEY,
    DEFAULT_DISCORD_SEND_TIMEOUT_MS,
  );
}
