import type { ConfigService } from '@nestjs/config';
import type { Client } from 'discord.js';
import { DiscordGuildMembershipService } from './discord-guild-membership.service';

function buildConfigService(guildId?: string): ConfigService {
  return {
    get: (key: string) => (key === 'DISCORD_GUILD_ID' ? guildId : undefined),
  } as unknown as ConfigService;
}

describe('DiscordGuildMembershipService (#232 fail-closed)', () => {
  it('returns false when DISCORD_GUILD_ID is not set (cannot verify)', async () => {
    const client = {} as unknown as Client;
    const service = new DiscordGuildMembershipService(
      client,
      buildConfigService(undefined),
    );

    await expect(service.isMember('discord-user-1')).resolves.toBe(false);
  });

  it('returns true when the user is a member', async () => {
    const client = {
      guilds: {
        fetch: jest.fn().mockResolvedValue({
          members: {
            fetch: jest.fn().mockResolvedValue({ id: 'discord-user-1' }),
          },
        }),
      },
    } as unknown as Client;
    const service = new DiscordGuildMembershipService(
      client,
      buildConfigService('guild-1'),
    );

    await expect(service.isMember('discord-user-1')).resolves.toBe(true);
  });

  it('returns false when membership lookup fails', async () => {
    const client = {
      guilds: {
        fetch: jest.fn().mockResolvedValue({
          members: {
            fetch: jest.fn().mockRejectedValue(new Error('not found')),
          },
        }),
      },
    } as unknown as Client;
    const service = new DiscordGuildMembershipService(
      client,
      buildConfigService('guild-1'),
    );

    await expect(service.isMember('discord-user-1')).resolves.toBe(false);
  });
});
