import type { ConfigService } from '@nestjs/config';
import type { Client } from 'discord.js';
import { DiscordGuildMembershipAdapter } from './discord-guild-membership.adapter';

function buildConfigService(guildId?: string): ConfigService {
  return {
    get: (key: string) => (key === 'DISCORD_GUILD_ID' ? guildId : undefined),
  } as unknown as ConfigService;
}

describe('DiscordGuildMembershipAdapter (#232 fail-closed)', () => {
  it('returns false when DISCORD_GUILD_ID is not set (cannot verify)', async () => {
    const client = {} as unknown as Client;
    const adapter = new DiscordGuildMembershipAdapter(
      client,
      buildConfigService(undefined),
    );

    await expect(adapter.isMember('discord-user-1')).resolves.toBe(false);
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
    const adapter = new DiscordGuildMembershipAdapter(
      client,
      buildConfigService('guild-1'),
    );

    await expect(adapter.isMember('discord-user-1')).resolves.toBe(true);
  });

  it('retries a transient Discord API error and succeeds when the next fetch works', async () => {
    const memberFetch = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Discord API unavailable'), { status: 503 }),
      )
      .mockResolvedValue({ id: 'discord-user-1' });
    const client = {
      guilds: {
        fetch: jest.fn().mockResolvedValue({
          members: { fetch: memberFetch },
        }),
      },
    } as unknown as Client;
    const adapter = new DiscordGuildMembershipAdapter(
      client,
      buildConfigService('guild-1'),
    );

    await expect(adapter.isMember('discord-user-1')).resolves.toBe(true);
    expect(memberFetch).toHaveBeenCalledTimes(2);
  });

  it('returns false for Discord Unknown Member without retrying', async () => {
    const memberFetch = jest.fn().mockRejectedValue(
      Object.assign(new Error('Unknown Member'), {
        code: 10007,
        status: 404,
      }),
    );
    const client = {
      guilds: {
        fetch: jest.fn().mockResolvedValue({
          members: {
            fetch: memberFetch,
          },
        }),
      },
    } as unknown as Client;
    const adapter = new DiscordGuildMembershipAdapter(
      client,
      buildConfigService('guild-1'),
    );

    await expect(adapter.isMember('discord-user-1')).resolves.toBe(false);
    expect(memberFetch).toHaveBeenCalledTimes(1);
  });

  it('throws after retrying an ambiguous membership lookup failure', async () => {
    const failure = new Error('Discord API unavailable');
    const memberFetch = jest.fn().mockRejectedValue(failure);
    const client = {
      guilds: {
        fetch: jest.fn().mockResolvedValue({
          members: { fetch: memberFetch },
        }),
      },
    } as unknown as Client;
    const adapter = new DiscordGuildMembershipAdapter(
      client,
      buildConfigService('guild-1'),
    );

    await expect(adapter.isMember('discord-user-1')).rejects.toBe(failure);
    expect(memberFetch).toHaveBeenCalledTimes(3);
  });
});
