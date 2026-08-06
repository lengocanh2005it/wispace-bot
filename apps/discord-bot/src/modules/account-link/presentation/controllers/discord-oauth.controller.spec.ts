/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import type { Response } from 'express';
import { DiscordOauthController } from './discord-oauth.controller';
import type { ConfigService } from '@nestjs/config';
import type { DiscordAccountLinkService } from '../../application/services/discord-account-link.service';
import type { WispaceTokenVerifyService } from '@wispace/wispace-client';
import type { DiscordOutboundService } from '@discord/modules/discord-chat/application/services/discord-outbound.service';
import type { DiscordGuildMembershipService } from '../../application/services/discord-guild-membership.service';
import type { DiscordPendingJoinService } from '../../application/services/discord-pending-join.service';

function buildConfigService(
  overrides: Record<string, string> = {},
): ConfigService {
  const values: Record<string, string> = {
    DISCORD_CLIENT_ID: 'client-id',
    DISCORD_OAUTH_REDIRECT_URI:
      'https://bot.example.com/discord/oauth/callback',
    ...overrides,
  };
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const v = values[key];
      if (!v) throw new Error(`Missing env: ${key}`);
      return v;
    },
  } as unknown as ConfigService;
}

function buildResponse(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.type = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.redirect = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

/** Default mock: user is already in the guild (happy path). */
function buildGuildMembershipService(
  inGuild = true,
): DiscordGuildMembershipService {
  return {
    isMember: jest.fn().mockResolvedValue(inGuild),
  } as unknown as DiscordGuildMembershipService;
}

function buildPendingJoinService(): DiscordPendingJoinService {
  return {
    create: jest.fn().mockReturnValue('pending-token-123'),
    get: jest.fn(),
    delete: jest.fn(),
  } as unknown as DiscordPendingJoinService;
}

describe('DiscordOauthController', () => {
  it('returns 400 when code or state is missing', async () => {
    const tokenVerifyService = {
      verifyToken: jest.fn(),
    } as unknown as WispaceTokenVerifyService;
    const accountLinkService = {
      exchangeCodeForDiscordUser: jest.fn(),
    } as unknown as DiscordAccountLinkService;
    const outboundService = {} as DiscordOutboundService;
    const controller = new DiscordOauthController(
      buildConfigService(),
      tokenVerifyService,
      accountLinkService,
      outboundService,
      buildGuildMembershipService(),
      buildPendingJoinService(),
    );
    const res = buildResponse();

    await controller.callback(undefined, 'token', undefined, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(
      accountLinkService.exchangeCodeForDiscordUser,
    ).not.toHaveBeenCalled();
  });

  it('returns 400 when the WISPACE token is invalid', async () => {
    const tokenVerifyService = {
      verifyToken: jest
        .fn()
        .mockResolvedValue({ valid: false, reason: 'EXPIRED' }),
    } as unknown as WispaceTokenVerifyService;
    const accountLinkService = {
      exchangeCodeForDiscordUser: jest
        .fn()
        .mockResolvedValue({ id: 'discord-user-1', username: 'TestUser' }),
      upsertLink: jest.fn(),
    } as unknown as DiscordAccountLinkService;
    const outboundService = {
      sendTextAndGetChannelId: jest.fn(),
    } as unknown as DiscordOutboundService;
    const controller = new DiscordOauthController(
      buildConfigService(),
      tokenVerifyService,
      accountLinkService,
      outboundService,
      buildGuildMembershipService(),
      buildPendingJoinService(),
    );
    const res = buildResponse();

    await controller.callback('code', 'bad-token', undefined, res);

    expect(tokenVerifyService.verifyToken).toHaveBeenCalledWith(
      'bad-token',
      'discord-user-1',
    );
    expect(accountLinkService.upsertLink).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('links the account and sends a welcome DM on success', async () => {
    const tokenVerifyService = {
      verifyToken: jest.fn().mockResolvedValue({ valid: true, userId: 143 }),
    } as unknown as WispaceTokenVerifyService;
    const accountLinkService = {
      exchangeCodeForDiscordUser: jest
        .fn()
        .mockResolvedValue({ id: 'discord-user-1', username: 'TestUser' }),
      upsertLink: jest.fn().mockResolvedValue(undefined),
    } as unknown as DiscordAccountLinkService;
    const outboundService = {
      sendTextAndGetChannelId: jest.fn().mockResolvedValue('dm-channel-123'),
    } as unknown as DiscordOutboundService;
    const controller = new DiscordOauthController(
      buildConfigService(),
      tokenVerifyService,
      accountLinkService,
      outboundService,
      buildGuildMembershipService(true),
      buildPendingJoinService(),
    );
    const res = buildResponse();

    await controller.callback('code', 'good-token', undefined, res);

    expect(accountLinkService.exchangeCodeForDiscordUser).toHaveBeenCalledWith(
      'code',
    );
    expect(accountLinkService.upsertLink).toHaveBeenCalledWith(
      143,
      'discord-user-1',
    );
    expect(outboundService.sendTextAndGetChannelId).toHaveBeenCalledWith(
      'discord-user-1',
      expect.any(String),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('issues a pending token when user is not in the guild', async () => {
    const tokenVerifyService = {
      verifyToken: jest.fn().mockResolvedValue({ valid: true, userId: 143 }),
    } as unknown as WispaceTokenVerifyService;
    const accountLinkService = {
      exchangeCodeForDiscordUser: jest
        .fn()
        .mockResolvedValue({ id: 'discord-user-1', username: 'TestUser' }),
      upsertLink: jest.fn(),
    } as unknown as DiscordAccountLinkService;
    const outboundService = {
      sendTextAndGetChannelId: jest.fn(),
    } as unknown as DiscordOutboundService;
    const pendingJoinService = buildPendingJoinService();
    const controller = new DiscordOauthController(
      buildConfigService(),
      tokenVerifyService,
      accountLinkService,
      outboundService,
      buildGuildMembershipService(false),
      pendingJoinService,
    );
    const res = buildResponse();

    await controller.callback('code', 'good-token', undefined, res);

    expect(pendingJoinService.create).toHaveBeenCalledWith(
      'discord-user-1',
      143,
      'TestUser',
    );
    expect(accountLinkService.upsertLink).not.toHaveBeenCalled();
    // Inline fallback: no DISCORD_OAUTH_FRONTEND_CALLBACK_URL set → res.status(200) pending HTML
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('redirects to frontend callback URL when DISCORD_OAUTH_FRONTEND_CALLBACK_URL is set', async () => {
    const tokenVerifyService = {
      verifyToken: jest.fn().mockResolvedValue({ valid: true, userId: 143 }),
    } as unknown as WispaceTokenVerifyService;
    const accountLinkService = {
      exchangeCodeForDiscordUser: jest
        .fn()
        .mockResolvedValue({ id: 'discord-user-1', username: 'TestUser' }),
      upsertLink: jest.fn().mockResolvedValue(undefined),
    } as unknown as DiscordAccountLinkService;
    const outboundService = {
      sendTextAndGetChannelId: jest.fn().mockResolvedValue('dm-channel-123'),
    } as unknown as DiscordOutboundService;
    const controller = new DiscordOauthController(
      buildConfigService({
        DISCORD_OAUTH_FRONTEND_CALLBACK_URL:
          'http://localhost:4321/callback.html',
      }),
      tokenVerifyService,
      accountLinkService,
      outboundService,
      buildGuildMembershipService(true),
      buildPendingJoinService(),
    );
    const res = buildResponse();

    await controller.callback('code', 'good-token', undefined, res);

    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('localhost:4321/callback.html'),
    );
  });

  it('returns 400 when the Discord code exchange fails', async () => {
    const tokenVerifyService = {
      verifyToken: jest.fn(),
    } as unknown as WispaceTokenVerifyService;
    const accountLinkService = {
      exchangeCodeForDiscordUser: jest
        .fn()
        .mockRejectedValue(new Error('Discord token exchange failed: 400')),
    } as unknown as DiscordAccountLinkService;
    const outboundService = {} as DiscordOutboundService;
    const controller = new DiscordOauthController(
      buildConfigService(),
      tokenVerifyService,
      accountLinkService,
      outboundService,
      buildGuildMembershipService(),
      buildPendingJoinService(),
    );
    const res = buildResponse();

    await controller.callback('code', 'good-token', undefined, res);

    expect(tokenVerifyService.verifyToken).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
