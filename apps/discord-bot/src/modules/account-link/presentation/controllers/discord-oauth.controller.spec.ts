/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- Jest mock assertions */
import type { Response } from 'express';
import { DiscordOauthController } from './discord-oauth.controller';
import type { ConfigService } from '@nestjs/config';
import type { DiscordAccountLinkService } from '../../application/services/discord-account-link.service';
import type { DiscordLinkVerifyRecordRepositoryPort } from '../../domain/ports/discord-link-verify-record.repository.port';
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

function buildVerifyRecordService(): DiscordLinkVerifyRecordRepositoryPort {
  return {
    recordVerify: jest.fn().mockResolvedValue(undefined),
    consumeRecord: jest.fn().mockResolvedValue(undefined),
  };
}

function buildAccountLinkService(
  options: {
    upsertFailsFirst?: boolean;
    upsertResult?: { relinked: boolean; previousUserId?: number };
  } = {},
): DiscordAccountLinkService {
  const result = options.upsertResult ?? { relinked: false };
  const upsertLink = options.upsertFailsFirst
    ? jest
        .fn()
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce(result)
    : jest.fn().mockResolvedValue(result);
  return {
    exchangeCodeForDiscordUser: jest
      .fn()
      .mockResolvedValue({ id: 'discord-user-1', username: 'TestUser' }),
    upsertLink,
    markWelcomed: jest.fn().mockResolvedValue(undefined),
    shouldWelcome: jest.fn().mockResolvedValue(true),
  } as unknown as DiscordAccountLinkService;
}

function buildOutboundService(): DiscordOutboundService {
  return {
    sendMenuButtons: jest.fn().mockResolvedValue('dm-channel-123'),
    sendText: jest.fn().mockResolvedValue(undefined),
  } as unknown as DiscordOutboundService;
}

function buildRelinkNotifier(): DiscordRelinkNotifier {
  return {
    notify: jest.fn().mockResolvedValue(undefined),
  };
}

function buildController(
  overrides: {
    inGuild?: boolean;
    valid?: boolean;
    accountLink?: DiscordAccountLinkService;
    outbound?: DiscordOutboundService;
    verifyRecord?: DiscordLinkVerifyRecordRepositoryPort;
    relinkNotifier?: DiscordRelinkNotifier;
  } = {},
): {
  controller: DiscordOauthController;
  accountLinkService: DiscordAccountLinkService;
  verifyRecordService: DiscordLinkVerifyRecordRepositoryPort;
  outboundService: DiscordOutboundService;
} {
  const accountLinkService = overrides.accountLink ?? buildAccountLinkService();
  const outboundService = overrides.outbound ?? buildOutboundService();
  const verifyRecordService =
    overrides.verifyRecord ?? buildVerifyRecordService();
  const controller = new DiscordOauthController(
    buildConfigService(),
    buildVerifyService(overrides.valid),
    accountLinkService,
    verifyRecordService,
    outboundService,
    buildMembershipService(overrides.inGuild ?? true),
    overrides.relinkNotifier ?? buildRelinkNotifier(),
  );
  return {
    controller,
    accountLinkService,
    verifyRecordService,
    outboundService,
  };
}

describe('DiscordOauthController', () => {
  it('links immediately and redirects to the landing page when already in the guild', async () => {
    const { controller, accountLinkService, outboundService } =
      buildController();
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

  it('#137: records the verify intent before the upsert and consumes it after', async () => {
    const { controller, verifyRecordService } = buildController();
    const res = buildResponse();

    await controller.callback('code', 'good-token', undefined, res);

    expect(verifyRecordService.recordVerify).toHaveBeenCalledWith(
      'discord-user-1',
      143,
    );
    expect(verifyRecordService.consumeRecord).toHaveBeenCalledWith(
      'discord-user-1',
    );
  });

  it('#137: does not record a verify intent when the token is invalid', async () => {
    const { controller, verifyRecordService } = buildController({
      valid: false,
    });
    const res = buildResponse();

    await controller.callback('code', 'bad-token', undefined, res);

    expect(verifyRecordService.recordVerify).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(LANDING_URL);
  });

  it('#137: marks the user welcomed when the welcome DM is sent at callback', async () => {
    const { controller, accountLinkService } = buildController();
    const res = buildResponse();

    await controller.callback('code', 'good-token', undefined, res);

    expect(accountLinkService.markWelcomed).toHaveBeenCalledWith(
      'discord-user-1',
    );
  });

  it('#137: does not mark welcomed when not in the guild (welcome happens on join)', async () => {
    const { controller, accountLinkService } = buildController({
      inGuild: false,
    });
    const res = buildResponse();

    await controller.callback('code', 'good-token', undefined, res);

    expect(accountLinkService.markWelcomed).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(INVITE_URL);
  });

  it('#137: skips the welcome DM when the user was welcomed within the window (join raced the callback)', async () => {
    const accountLinkService = buildAccountLinkService();
    (accountLinkService.shouldWelcome as jest.Mock).mockResolvedValue(false);
    const { controller, outboundService } = buildController({
      accountLink: accountLinkService,
    });
    const res = buildResponse();

    await controller.callback('code', 'good-token', undefined, res);

    expect(outboundService.sendMenuButtons).not.toHaveBeenCalled();
    expect(accountLinkService.markWelcomed).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(LANDING_URL);
  });

  it('#137: notifies the Discord account when the link displaced another WISPACE user', async () => {
    const accountLinkService = buildAccountLinkService({
      upsertResult: { relinked: true, previousUserId: 99 },
    });
    const relinkNotifier = buildRelinkNotifier();
    const { controller } = buildController({
      accountLink: accountLinkService,
      relinkNotifier,
    });
    const res = buildResponse();

    await controller.callback('code', 'good-token', undefined, res);

    expect(relinkNotifier.notify).toHaveBeenCalledWith('discord-user-1', 99);
  });

  it('#137: no relink notice when the link is new or unchanged', async () => {
    const relinkNotifier = buildRelinkNotifier();
    const { controller } = buildController({ relinkNotifier });
    const res = buildResponse();

    await controller.callback('code', 'good-token', undefined, res);

    expect(relinkNotifier.notify).not.toHaveBeenCalled();
  });

  it('links immediately and redirects to the invite when NOT in the guild (no pending flow)', async () => {
    const { controller, outboundService } = buildController({ inGuild: false });
    const res = buildResponse();

    await controller.callback('code', 'good-token', undefined, res);

    // Link is committed regardless of membership — no pending token involved.
    expect(outboundService.sendMenuButtons).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(INVITE_URL);
    const redirectUrl = String(
      ((res.redirect as jest.Mock).mock.calls as string[][])[0]?.[0],
    );
    expect(redirectUrl).not.toContain('pendingToken');
  });

  it('does not link when the WISPACE token is invalid', async () => {
    const { controller, accountLinkService } = buildController({
      valid: false,
    });
    const res = buildResponse();

    await controller.callback('code', 'bad-token', undefined, res);

    expect(accountLinkService.upsertLink).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(LANDING_URL);
  });

  it('returns missing-param errors to the landing page', async () => {
    const { controller, accountLinkService } = buildController();
    const res = buildResponse();

    await controller.callback(undefined, 'token', undefined, res);
    expect(res.redirect).toHaveBeenCalledWith(LANDING_URL);

    await controller.callback('code', undefined, undefined, res);
    expect(res.redirect).toHaveBeenCalledWith(LANDING_URL);
    expect(accountLinkService.upsertLink).not.toHaveBeenCalled();
  });

  it('redirects cancelled grants to the landing page', async () => {
    const { controller, accountLinkService } = buildController();
    const res = buildResponse();

    await controller.callback('code', 'token', 'access_denied', res);

    expect(accountLinkService.upsertLink).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(LANDING_URL);
  });

  it('retries the link upsert on transient DB failure (token already consumed)', async () => {
    const accountLinkService = buildAccountLinkService({
      upsertFailsFirst: true,
    });
    const { controller } = buildController({ accountLink: accountLinkService });
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
    const { controller } = buildController({ accountLink: accountLinkService });
    const res = buildResponse();

    await controller.callback('code', 'good-token', undefined, res);

    expect(accountLinkService.upsertLink).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(LANDING_URL);
  });
});
