/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import type { Response } from 'express';
import { DiscordLinkStatusController } from './discord-link-status.controller';
import type { DiscordAccountLinkService } from '../../application/services/discord-account-link.service';
import type { DiscordGuildMembershipPort } from '../../domain/ports/discord-guild-membership.port';

function buildResponse(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function buildServices(options: { discordId?: string; inGuild?: boolean }): {
  accountLinkService: DiscordAccountLinkService;
  guildMembershipService: DiscordGuildMembershipPort;
} {
  return {
    accountLinkService: {
      findDiscordIdByUserId: jest.fn().mockResolvedValue(options.discordId),
    } as unknown as DiscordAccountLinkService,
    guildMembershipService: {
      isMember: jest.fn().mockResolvedValue(options.inGuild ?? false),
    } as unknown as DiscordGuildMembershipPort,
  };
}

describe('DiscordLinkStatusController', () => {
  it('returns linked=false when the user has no Discord mapping', async () => {
    const { accountLinkService, guildMembershipService } = buildServices({});
    const controller = new DiscordLinkStatusController(
      accountLinkService,
      guildMembershipService,
    );
    const res = buildResponse();

    await controller.getLinkStatus('42', res);

    expect(accountLinkService.findDiscordIdByUserId).toHaveBeenCalledWith(42);
    expect(guildMembershipService.isMember).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ linked: false, inGuild: false });
  });

  it('returns linked=true + inGuild=true for a member', async () => {
    const { accountLinkService, guildMembershipService } = buildServices({
      discordId: 'discord-user-1',
      inGuild: true,
    });
    const controller = new DiscordLinkStatusController(
      accountLinkService,
      guildMembershipService,
    );
    const res = buildResponse();

    await controller.getLinkStatus('42', res);

    expect(guildMembershipService.isMember).toHaveBeenCalledWith(
      'discord-user-1',
    );
    expect(res.json).toHaveBeenCalledWith({ linked: true, inGuild: true });
  });

  it('returns linked=true + inGuild=false when the user never joined', async () => {
    const { accountLinkService, guildMembershipService } = buildServices({
      discordId: 'discord-user-1',
      inGuild: false,
    });
    const controller = new DiscordLinkStatusController(
      accountLinkService,
      guildMembershipService,
    );
    const res = buildResponse();

    await controller.getLinkStatus('42', res);

    expect(res.json).toHaveBeenCalledWith({ linked: true, inGuild: false });
  });

  it('fails open (inGuild=false) when the Discord guild check throws', async () => {
    const { accountLinkService, guildMembershipService } = buildServices({
      discordId: 'discord-user-1',
    });
    (guildMembershipService.isMember as jest.Mock).mockRejectedValue(
      new Error('discord api down'),
    );
    const controller = new DiscordLinkStatusController(
      accountLinkService,
      guildMembershipService,
    );
    const res = buildResponse();

    await controller.getLinkStatus('42', res);

    expect(res.json).toHaveBeenCalledWith({ linked: true, inGuild: false });
  });

  it('rejects an invalid userId', async () => {
    const { accountLinkService } = buildServices({});
    const controller = new DiscordLinkStatusController(
      accountLinkService,
      {} as DiscordGuildMembershipPort,
    );
    const res = buildResponse();

    await controller.getLinkStatus('not-a-number', res);

    expect(accountLinkService.findDiscordIdByUserId).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'userId must be a positive integer',
    });
  });
});
