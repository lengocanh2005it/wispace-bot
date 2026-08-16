import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'discord.js';

@Injectable()
export class DiscordGuildMembershipService {
  private readonly logger = new Logger(DiscordGuildMembershipService.name);
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

    try {
      const guild = await this.client.guilds.fetch(this.guildId);
      await guild.members.fetch(discordUserId);
      return true;
    } catch {
      return false;
    }
  }
}
