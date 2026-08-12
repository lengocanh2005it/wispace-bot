/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import type { Response } from 'express';
import type { ConfigService } from '@nestjs/config';
import type { DiscordAccountLinkService } from '../../application/services/discord-account-link.service';
import type { DiscordGuildMembershipService } from '../../application/services/discord-guild-membership.service';
import type { DiscordOutboundService } from '@discord/modules/discord-chat/application/services/discord-outbound.service';
import type { DiscordPendingJoinService } from '../../application/services/discord-pending-join.service';
import { DiscordGuildController } from './discord-guild.controller';

function buildResponse(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

describe('DiscordGuildController', () => {
  it('sends menu buttons when completing a pending OAuth link', async () => {
    const pendingJoinService = {
      get: jest.fn().mockReturnValue({
        discordUserId: 'discord-user-1',
        wispaceUserId: 143,
        discordUsername: 'TestUser',
        expiresAt: Date.now() + 60_000,
      }),
      delete: jest.fn(),
    } as unknown as DiscordPendingJoinService;
    const accountLinkService = {
      upsertLink: jest.fn().mockResolvedValue(undefined),
    } as unknown as DiscordAccountLinkService;
    const outboundService = {
      sendTextAndGetChannelId: jest.fn(),
      sendMenuButtons: jest.fn().mockResolvedValue('dm-channel-123'),
    } as unknown as DiscordOutboundService;
    const controller = new DiscordGuildController(
      {
        getOrThrow: jest.fn().mockReturnValue('bot-user-1'),
      } as unknown as ConfigService,
      pendingJoinService,
      {
        isMember: jest.fn().mockResolvedValue(true),
      } as unknown as DiscordGuildMembershipService,
      accountLinkService,
      outboundService,
    );
    const res = buildResponse();

    await controller.completeLink('pending-token', res);

    expect(outboundService.sendMenuButtons).toHaveBeenCalledWith(
      'discord-user-1',
      expect.any(String),
    );
    expect(outboundService.sendTextAndGetChannelId).not.toHaveBeenCalled();
  });
});
