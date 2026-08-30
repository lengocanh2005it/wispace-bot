import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { DiscordLinkCompletionService } from '../../application/services/discord-link-completion.service';
import { DiscordOauthStateService } from '../../application/services/discord-oauth-state.service';
import { DiscordOauthController } from './discord-oauth.controller';

describe('DiscordOauthController HTTP binding (#388)', () => {
  let app: INestApplication;
  let baseUrl: string;

  const configService = {
    getOrThrow: jest.fn((key: string) => {
      const vars: Record<string, string> = {
        DISCORD_CLIENT_ID: 'client-id',
        DISCORD_OAUTH_REDIRECT_URI:
          'https://bot.example.com/discord/oauth/callback',
        DISCORD_LINK_LANDING_URL: 'https://landing.example.com',
      };
      return vars[key];
    }),
    get: jest.fn(),
  };
  const stateService = { create: jest.fn(), consume: jest.fn() };
  const completionService = { completeLink: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DiscordOauthController],
      providers: [
        { provide: ConfigService, useValue: configService },
        { provide: DiscordOauthStateService, useValue: stateService },
        { provide: DiscordLinkCompletionService, useValue: completionService },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('completes the link through a real HTTP request with a valid state cookie', async () => {
    stateService.consume.mockResolvedValueOnce({ linkToken: 'link-token-123' });
    completionService.completeLink.mockResolvedValueOnce('success');

    const response = await fetch(
      `${baseUrl}/discord/oauth/callback?code=auth-code&state=state-nonce`,
      {
        headers: { cookie: '__Host-discord_oauth_state=state-nonce' },
        redirect: 'manual',
      },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://landing.example.com',
    );
    expect(completionService.completeLink).toHaveBeenCalledWith(
      'auth-code',
      'link-token-123',
    );
  });

  it('rejects a forwarded callback URL that has no state cookie', async () => {
    const response = await fetch(
      `${baseUrl}/discord/oauth/callback?code=auth-code&state=state-nonce`,
      { redirect: 'manual' },
    );

    expect(response.status).toBe(302);
    expect(stateService.consume).not.toHaveBeenCalledWith('state-nonce');
    expect(completionService.completeLink).not.toHaveBeenCalled();
  });

  it('rejects a mismatched state cookie without consuming the state', async () => {
    const response = await fetch(
      `${baseUrl}/discord/oauth/callback?code=auth-code&state=state-nonce`,
      {
        headers: { cookie: '__Host-discord_oauth_state=different-state' },
        redirect: 'manual',
      },
    );

    expect(response.status).toBe(302);
    expect(stateService.consume).not.toHaveBeenCalledWith('state-nonce');
    expect(completionService.completeLink).not.toHaveBeenCalled();
  });

  it('rejects an oversized link token like a missing one (indistinguishable)', async () => {
    const response = await fetch(
      `${baseUrl}/discord/oauth/url?state=${'a'.repeat(513)}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: '' });
    expect(stateService.create).not.toHaveBeenCalled();
  });
});
