/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import type { Request, Response } from 'express';
import type { ConfigService } from '@nestjs/config';
import type { DiscordAccountLinkService } from '../../application/services/discord-account-link.service';
import type { DiscordGuildMembershipService } from '../../application/services/discord-guild-membership.service';
import type { DiscordOutboundService } from '@discord/modules/discord-chat/application/services/discord-outbound.service';
import type { DiscordPendingJoinService } from '../../application/services/discord-pending-join.service';
import { DiscordGuildController } from './discord-guild.controller';
import { PENDING_LINK_COOKIE_NAME } from '../../application/services/discord-pending-join.service';

const PENDING_TOKEN = 'pending-token-123';

function buildRequest(): Request {
  return {
    headers: {
      cookie: `${PENDING_LINK_COOKIE_NAME}=${PENDING_TOKEN}`,
    },
  } as unknown as Request;
}

function buildRequestWithoutCookie(): Request {
  return { headers: {} } as unknown as Request;
}

function buildResponse(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.clearCookie = jest.fn().mockReturnValue(res);
  return res as Response;
}

function buildPendingJoinService(
  entry: unknown = {
    discordUserId: 'discord-user-1',
    wispaceUserId: 143,
    discordUsername: 'TestUser',
    expiresAt: Date.now() + 60_000,
  },
): DiscordPendingJoinService {
  return {
    get: jest.fn().mockReturnValue(entry),
    consume: jest.fn().mockReturnValue(entry),
    delete: jest.fn(),
  } as unknown as DiscordPendingJoinService;
}

describe('DiscordGuildController', () => {
  it('consumes the cookie capability and completes the link', async () => {
    const pendingJoinService = buildPendingJoinService();
    const accountLinkService = {
      upsertLink: jest.fn().mockResolvedValue(undefined),
    } as unknown as DiscordAccountLinkService;
    const outboundService = {
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

    await controller.completeLink(buildRequest(), res);

    expect(pendingJoinService.consume).toHaveBeenCalledWith(PENDING_TOKEN);
    expect(accountLinkService.upsertLink).toHaveBeenCalledWith(
      143,
      'discord-user-1',
    );
    expect(outboundService.sendMenuButtons).toHaveBeenCalledWith(
      'discord-user-1',
      expect.any(String),
    );
    expect(res.clearCookie).toHaveBeenCalledWith(
      PENDING_LINK_COOKIE_NAME,
      expect.objectContaining({ httpOnly: true }),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, dmChannelId: 'dm-channel-123' }),
    );
  });

  it('rejects a replayed capability (already consumed)', async () => {
    const pendingJoinService = buildPendingJoinService(null);
    const controller = new DiscordGuildController(
      {
        getOrThrow: jest.fn(),
      } as unknown as ConfigService,
      pendingJoinService,
      {} as DiscordGuildMembershipService,
      {} as DiscordAccountLinkService,
      {} as DiscordOutboundService,
    );
    const res = buildResponse();

    await controller.completeLink(buildRequest(), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'TOKEN_EXPIRED' });
  });

  it('rejects a request without the pending cookie', async () => {
    const controller = new DiscordGuildController(
      {} as ConfigService,
      {} as DiscordPendingJoinService,
      {} as DiscordGuildMembershipService,
      {} as DiscordAccountLinkService,
      {} as DiscordOutboundService,
    );
    const res = buildResponse();

    await controller.completeLink(buildRequestWithoutCookie(), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Missing token' });
  });

  it('rejects completion when the user is not in the guild', async () => {
    const pendingJoinService = buildPendingJoinService();
    const controller = new DiscordGuildController(
      {} as ConfigService,
      pendingJoinService,
      {
        isMember: jest.fn().mockResolvedValue(false),
      } as unknown as DiscordGuildMembershipService,
      {} as DiscordAccountLinkService,
      {} as DiscordOutboundService,
    );
    const res = buildResponse();

    await controller.completeLink(buildRequest(), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'NOT_IN_GUILD' });
  });

  it('join-status reports joined when the guild membership check passes', async () => {
    const pendingJoinService = buildPendingJoinService();
    const controller = new DiscordGuildController(
      {} as ConfigService,
      pendingJoinService,
      {
        isMember: jest.fn().mockResolvedValue(true),
      } as unknown as DiscordGuildMembershipService,
      {} as DiscordAccountLinkService,
      {} as DiscordOutboundService,
    );
    const res = buildResponse();

    await controller.getJoinStatus(buildRequest(), res);

    expect(res.json).toHaveBeenCalledWith({
      joined: true,
      completed: false,
      expired: false,
    });
  });

  it('join-status reports expired without a cookie and never leaks data', async () => {
    const controller = new DiscordGuildController(
      {} as ConfigService,
      {} as DiscordPendingJoinService,
      {} as DiscordGuildMembershipService,
      {} as DiscordAccountLinkService,
      {} as DiscordOutboundService,
    );
    const res = buildResponse();

    await controller.getJoinStatus(buildRequestWithoutCookie(), res);

    expect(res.json).toHaveBeenCalledWith({
      expired: true,
      joined: false,
      completed: false,
    });
  });
});
