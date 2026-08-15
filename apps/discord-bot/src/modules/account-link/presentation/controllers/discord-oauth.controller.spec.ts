/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment -- Jest mock assertions */
import type { Response } from 'express';
import { DiscordOauthController } from './discord-oauth.controller';
import type { ConfigService } from '@nestjs/config';
import type { DiscordLinkCompletionService } from '../../application/services/discord-link-completion.service';

const LANDING_URL = 'https://testfrontend.aihubproduction.com/';
const INVITE_URL = 'https://discord.gg/wispace';

function buildConfigService(): ConfigService {
  const values: Record<string, string> = {
    DISCORD_CLIENT_ID: 'client-id',
    DISCORD_OAUTH_REDIRECT_URI:
      'https://bot.example.com/discord/oauth/callback',
    DISCORD_LINK_LANDING_URL: LANDING_URL,
    DISCORD_INVITE_URL: INVITE_URL,
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

function buildCompletionService(
  outcome: 'success' | 'not-in-guild',
): DiscordLinkCompletionService {
  return {
    completeLink: jest.fn().mockResolvedValue(outcome),
  } as unknown as DiscordLinkCompletionService;
}

describe('DiscordOauthController (thin presentation)', () => {
  it('delegates the callback to the completion use case and redirects to the landing page', async () => {
    const completionService = buildCompletionService('success');
    const controller = new DiscordOauthController(
      buildConfigService(),
      completionService,
    );
    const res = buildResponse();

    await controller.callback('code', 'good-token', undefined, res);

    expect(completionService.completeLink).toHaveBeenCalledWith(
      'code',
      'good-token',
    );
    expect(res.redirect).toHaveBeenCalledWith(LANDING_URL);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Referrer-Policy',
      'no-referrer',
    );
  });

  it('redirects to the invite when the user is not in the guild yet', async () => {
    const completionService = buildCompletionService('not-in-guild');
    const controller = new DiscordOauthController(
      buildConfigService(),
      completionService,
    );
    const res = buildResponse();

    await controller.callback('code', 'good-token', undefined, res);

    expect(res.redirect).toHaveBeenCalledWith(INVITE_URL);
    const redirectUrl = String(
      ((res.redirect as jest.Mock).mock.calls as string[][])[0]?.[0],
    );
    expect(redirectUrl).not.toContain('token');
  });

  it('redirects to the landing page when the use case throws', async () => {
    const completionService = {
      completeLink: jest.fn().mockRejectedValue(new Error('token rejected')),
    } as unknown as DiscordLinkCompletionService;
    const controller = new DiscordOauthController(
      buildConfigService(),
      completionService,
    );
    const res = buildResponse();

    await controller.callback('code', 'bad-token', undefined, res);

    expect(res.redirect).toHaveBeenCalledWith(LANDING_URL);
  });

  it('returns missing-param errors to the landing page without calling the use case', async () => {
    const completionService = buildCompletionService('success');
    const controller = new DiscordOauthController(
      buildConfigService(),
      completionService,
    );
    const res = buildResponse();

    await controller.callback(undefined, 'token', undefined, res);
    expect(res.redirect).toHaveBeenCalledWith(LANDING_URL);

    await controller.callback('code', undefined, undefined, res);
    expect(res.redirect).toHaveBeenCalledWith(LANDING_URL);
    expect(completionService.completeLink).not.toHaveBeenCalled();
  });

  it('redirects cancelled grants to the landing page without calling the use case', async () => {
    const completionService = buildCompletionService('success');
    const controller = new DiscordOauthController(
      buildConfigService(),
      completionService,
    );
    const res = buildResponse();

    await controller.callback('code', 'token', 'access_denied', res);

    expect(completionService.completeLink).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(LANDING_URL);
  });

  it('returns the OAuth authorize URL with state from WISPACE', () => {
    const controller = new DiscordOauthController(
      buildConfigService(),
      buildCompletionService('success'),
    );
    const res = buildResponse();
    controller.getOAuthUrl('wispace-token', res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining('https://discord.com/oauth2/authorize'),
      }),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining('client_id=client-id'),
      }),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining('state=wispace-token'),
      }),
    );
  });
});
