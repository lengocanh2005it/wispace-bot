import type { Platform } from '@wispace/contracts';

/**
 * Outbound rate limiting, as the chat feature needs it. #1450: the concrete
 * `OutboundRateLimiter` is `@Injectable() implements OnModuleInit` and takes a
 * Redis-backed service, so application code injecting it is a boundary
 * violation. The composition root binds that adapter to this token.
 *
 * The port names the capability, not the class: it exposes one decision, not
 * the limiter's Redis counters or its configuration.
 */
export type DiscordOutboundRateLimitOutcome =
  | 'allowed'
  | 'limited'
  | 'store_unavailable'
  | 'disabled';

export interface DiscordOutboundRateLimitVerdict {
  allowed: boolean;
  outcome: DiscordOutboundRateLimitOutcome;
}

export interface DiscordOutboundRateLimitPort {
  /** Asks whether one send is within budget, and why. */
  admit(input: {
    platform: Platform;
    externalUserId: string;
    userId?: number | null;
    units?: number;
  }): Promise<DiscordOutboundRateLimitVerdict>;
}

export const DISCORD_OUTBOUND_RATE_LIMIT = Symbol(
  'DISCORD_OUTBOUND_RATE_LIMIT',
);
