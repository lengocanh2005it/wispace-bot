/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import type { Response } from 'express';
import { DiscordOauthController } from './discord-oauth.controller';
import type { ConfigService } from '@nestjs/config';
import type { DiscordAccountLinkService } from '../../application/services/discord-account-link.service';
import type { WispaceTokenVerifyService } from '@wispace/wispace-client';
import type { DiscordOutboundService } from '@discord/modules/discord-chat/application/services/discord-outbound.service';
import type { DiscordGuildMembershipService } from '../../application/services/discord-guild-membership.service';

const LANDING_URL = 'https://testfrontend.aihubproduction.com/';
const INVITE_URL = 'https://discord.gg/wispace';

function buildConfigService(
  overrides: Record<string, string> = {},
): ConfigService {
  const values: Record<string, string> = {
    DISCORD_CLIENT_ID: 'client-id',
    DISCORD_OAUTH_REDIRECT_URI:
      'https://bot.example.com/discord/oauth/callback',
    DISCORD_LINK_LANDING_URL: LANDING_URL,
    DISCORD_INVITE_URL: INVITE_URL,
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
  res.setHeader = jest.fn().mockReturnValue(res);
  return res as Response;
}

function buildMembershipService(
  inGuild: boolean,
): DiscordGuildMembershipService {
  return {
    isMember: jest.fn().mockResolvedValue(inGuild),
  } as unknown as DiscordGuildMembershipService;
}

function buildVerifyService(valid = true): WispaceTokenVerifyService {
  return {
    verifyToken: jest
      .fn()
      .mockResolvedValue(
        valid
          ? { valid: true, userId: 143 }
          : { valid: false, reason: 'EXPIRED' },
      ),
  } as unknown as WispaceTokenVerifyService;
}

function buildAccountLinkService(
  options: { upsertFailsFirst?: boolean } = {},
): DiscordAccountLinkService {
  const upsertLink = options.upsertFailsFirst
    ? jest
        .fn()
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce(undefined)
    : jest.fn().mockResolvedValue(undefined);
  return {
    exchangeCodeForDiscordUser: jest
      .fn()
      .mockResolvedValue({ id: 'discord-user-1', username: 'TestUser' }),
    upsertLink,
  } as unknown as DiscordAccountLinkService;
}

describe('DiscordOauthController', () => {
  it('links immediately and redirects to the landing page when already in the guild', async () => {
    const accountLinkService = buildAccountLinkService();
    const outboundService = {
      sendMenuButtons: jest.fn().mockResolvedValue('dm-channel-123'),
    } as unknown as DiscordOutboundService;
    const controller = new DiscordOauthController(
      buildConfigService(),
      buildVerifyService(),
      accountLinkService,
      outboundService,
      buildMembershipService(true),
    );
    const res = buildResponse();

    await controller.callback('code', 'good-token', undefined, res);

    expect(accountLinkService.upsertLink).toHaveBeenCalledWith(
      143,
      'discord-user-1',
    );
    expect(outboundService.sendMenuButtons).toHaveBeenCalledWith(
      'discord-user-1',
      expect.any(String),
    );
    expect(res.redirect).toHaveBeenCalledWith(LANDING_URL);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Referrer-Policy',
      'no-referrer',
    );
  });

  it('links immediately and redirects to the invite when NOT in the guild (no pending flow)', async () => {
    const accountLinkService = buildAccountLinkService();
    const outboundService = {
      sendMenuButtons: jest.fn(),
    } as unknown as DiscordOutboundService;
    const controller = new DiscordOauthController(
      buildConfigService(),
      buildVerifyService(),
      accountLinkService,
      outboundService,
      buildMembershipService(false),
    );
    const res = buildResponse();

    await controller.callback('code', 'good-token', undefined, res);

    // Link is committed regardless of membership — no pending token involved.
    expect(accountLinkService.upsertLink).toHaveBeenCalledWith(
      143,
      'discord-user-1',
    );
    expect(outboundService.sendMenuButtons).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(INVITE_URL);
    const redirectUrl = String(
      ((res.redirect as jest.Mock).mock.calls as string[][])[0]?.[0],
    );
    expect(redirectUrl).not.toContain('pendingToken');
  });

  it('does not link when the WISPACE token is invalid', async () => {
    const accountLinkService = buildAccountLinkService();
    const controller = new DiscordOauthController(
      buildConfigService(),
      buildVerifyService(false),
      accountLinkService,
      {} as DiscordOutboundService,
      buildMembershipService(true),
    );
    const res = buildResponse();

    await controller.callback('code', 'bad-token', undefined, res);

    expect(accountLinkService.upsertLink).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(LANDING_URL);
  });

  it('returns missing-param errors to the landing page', async () => {
    const accountLinkService = buildAccountLinkService();
    const controller = new DiscordOauthController(
      buildConfigService(),
      buildVerifyService(),
      accountLinkService,
      {} as DiscordOutboundService,
      buildMembershipService(true),
    );
    const res = buildResponse();

    await controller.callback(undefined, 'token', undefined, res);
    expect(res.redirect).toHaveBeenCalledWith(LANDING_URL);

    await controller.callback('code', undefined, undefined, res);
    expect(res.redirect).toHaveBeenCalledWith(LANDING_URL);
    expect(accountLinkService.upsertLink).not.toHaveBeenCalled();
  });

  it('redirects cancelled grants to the landing page', async () => {
    const accountLinkService = buildAccountLinkService();
    const controller = new DiscordOauthController(
      buildConfigService(),
      buildVerifyService(),
      accountLinkService,
      {} as DiscordOutboundService,
      buildMembershipService(true),
    );
    const res = buildResponse();

    await controller.callback('code', 'token', 'access_denied', res);

    expect(accountLinkService.upsertLink).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(LANDING_URL);
  });

  it('retries the link upsert on transient DB failure (token already consumed)', async () => {
    const accountLinkService = buildAccountLinkService({
      upsertFailsFirst: true,
    });
    const controller = new DiscordOauthController(
      buildConfigService(),
      buildVerifyService(),
      accountLinkService,
      {} as DiscordOutboundService,
      buildMembershipService(true),
    );
    const res = buildResponse();

    await controller.callback('code', 'good-token', undefined, res);

    expect(accountLinkService.upsertLink).toHaveBeenCalledTimes(2);
    expect(res.redirect).toHaveBeenCalledWith(LANDING_URL);
  });

  it('redirects to the landing page when the Discord code exchange fails', async () => {
    const accountLinkService = {
      exchangeCodeForDiscordUser: jest
        .fn()
        .mockRejectedValue(new Error('Discord token exchange failed: 400')),
      upsertLink: jest.fn(),
    } as unknown as DiscordAccountLinkService;
    const controller = new DiscordOauthController(
      buildConfigService(),
      buildVerifyService(),
      accountLinkService,
      {} as DiscordOutboundService,
      buildMembershipService(true),
    );
    const res = buildResponse();

    await controller.callback('code', 'good-token', undefined, res);

    expect(accountLinkService.upsertLink).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(LANDING_URL);
  });
});
