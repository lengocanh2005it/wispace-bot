import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'discord.js';
import { errorMessage } from '@wispace/bot-common/masking';
import { jitteredDelayMs } from '@wispace/bot-common/utils';
import type { DiscordGuildMembershipPort } from '../../domain/ports/discord-guild-membership.port';

const MEMBERSHIP_CHECK_MAX_ATTEMPTS = 3;
const MEMBERSHIP_CHECK_RETRY_DELAY_MS = 100;
const MEMBERSHIP_CHECK_RETRY_DELAY_CAP_MS =
  MEMBERSHIP_CHECK_RETRY_DELAY_MS * (MEMBERSHIP_CHECK_MAX_ATTEMPTS - 1);
const UNKNOWN_MEMBER_ERROR_CODE = 10007;

export function getMembershipCheckRetryDelayMs(
  attempt: number,
  rng: () => number = Math.random,
): number {
  const nominalDelayMs = MEMBERSHIP_CHECK_RETRY_DELAY_MS * attempt;
  const cappedDelayMs = Math.min(
    nominalDelayMs,
    MEMBERSHIP_CHECK_RETRY_DELAY_CAP_MS,
  );
  return jitteredDelayMs(cappedDelayMs, rng);
}

/** discord.js guild-membership check behind the application port (#428). */
@Injectable()
export class DiscordGuildMembershipAdapter implements DiscordGuildMembershipPort {
  private readonly logger = new Logger(DiscordGuildMembershipAdapter.name);
  private readonly guildId: string | undefined;

  constructor(
    private readonly client: Client,
    private readonly configService: ConfigService,
  ) {
    this.guildId = this.configService.get<string>('DISCORD_GUILD_ID');
  }

  /**
   * Returns true if the user is a member of the configured DISCORD_GUILD_ID.
   * Fails closed when DISCORD_GUILD_ID is not set: membership cannot be
   * verified, so callers must defer the welcome to `guildMemberAdd` instead
   * of sending a DM into the void (#232).
   */
  async isMember(discordUserId: string): Promise<boolean> {
    if (!this.guildId) {
      this.logger.warn(
        'DISCORD_GUILD_ID not set — cannot verify guild membership (fail closed)',
      );
      return false;
    }

    for (let attempt = 1; attempt <= MEMBERSHIP_CHECK_MAX_ATTEMPTS; attempt++) {
      try {
        const guild = await this.client.guilds.fetch(this.guildId);
        await guild.members.fetch(discordUserId);
        return true;
      } catch (error) {
        if (isUnknownMemberError(error)) return false;

        if (attempt === MEMBERSHIP_CHECK_MAX_ATTEMPTS) {
          this.logger.warn(
            `Discord guild membership lookup failed after ${attempt} attempts: ${errorMessage(error, discordUserId)}`,
          );
          throw error;
        }

        await new Promise<void>((resolve) =>
          setTimeout(resolve, getMembershipCheckRetryDelayMs(attempt)),
        );
      }
    }

    return false;
  }
}

function isUnknownMemberError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  return (
    error.code === UNKNOWN_MEMBER_ERROR_CODE ||
    error.code === String(UNKNOWN_MEMBER_ERROR_CODE)
  );
}
