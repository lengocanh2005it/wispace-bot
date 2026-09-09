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

  // #948 — invalid link tokens must be an explicit 4xx with the shared
  // error body (mirroring the Zalo authorize endpoint), never a silent
  // 200 with an empty URL.
  it('rejects a missing link token with 400 and the shared error body', async () => {
    const response = await fetch(`${baseUrl}/discord/oauth/url`);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      message: 'Thiếu hoặc không hợp lệ link token.',
    });
    expect(stateService.create).not.toHaveBeenCalled();
  });

  it('rejects an oversized link token with 400 and the shared error body', async () => {
    const response = await fetch(
      `${baseUrl}/discord/oauth/url?state=${'a'.repeat(513)}`,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      message: 'Thiếu hoặc không hợp lệ link token.',
    });
    expect(stateService.create).not.toHaveBeenCalled();
  });

  it('keeps the valid-token path byte-identical: 200 {url}, no-store, cookie set', async () => {
    stateService.create.mockResolvedValueOnce('state-nonce');

    const response = await fetch(
      `${baseUrl}/discord/oauth/url?state=link-token-123`,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string };
    expect(body.url).toContain('https://discord.com/oauth2/authorize');
    expect(body.url).toContain('state=state-nonce');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('__Host-discord_oauth_state=state-nonce');
    expect(stateService.create).toHaveBeenCalledWith('link-token-123');
  });
});
