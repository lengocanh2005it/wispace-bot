import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ZaloAccountLinkService } from '../../application/services/zalo-account-link.service';
import { ZaloLinkCompletionService } from '../../application/services/zalo-link-completion.service';
import { ZaloOauthStateService } from '../../application/services/zalo-oauth-state.service';
import { ZaloOauthController } from './zalo-oauth.controller';

describe('ZaloOauthController HTTP binding (#388)', () => {
  let app: INestApplication;
  let baseUrl: string;

  const configService = {
    getOrThrow: jest.fn((key: string) => {
      const vars: Record<string, string> = {
        ZALO_APP_ID: 'app-1',
        ZALO_OAUTH_REDIRECT_URI:
          'https://zalo-bot.example.com/zalo/oauth/callback',
      };
      return vars[key];
    }),
  };
  const accountLinkService = { buildPkcePair: jest.fn() };
  const stateService = { create: jest.fn(), consume: jest.fn() };
  const completionService = { completeLink: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ZaloOauthController],
      providers: [
        { provide: ConfigService, useValue: configService },
        { provide: ZaloAccountLinkService, useValue: accountLinkService },
        { provide: ZaloOauthStateService, useValue: stateService },
        { provide: ZaloLinkCompletionService, useValue: completionService },
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
    stateService.consume.mockResolvedValueOnce({
      codeVerifier: 'verifier-1',
      linkToken: 'link-token-1',
    });
    completionService.completeLink.mockResolvedValueOnce(undefined);

    const response = await fetch(
      `${baseUrl}/zalo/oauth/callback?code=auth-code&state=state-1`,
      { headers: { cookie: '__Host-zalo_oauth_state=state-1' } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(completionService.completeLink).toHaveBeenCalledWith(
      'auth-code',
      'verifier-1',
      'link-token-1',
    );
  });

  it('rejects a forwarded callback URL that has no state cookie', async () => {
    const response = await fetch(
      `${baseUrl}/zalo/oauth/callback?code=auth-code&state=state-1`,
    );

    expect(await response.json()).toEqual(
      expect.objectContaining({ success: false }),
    );
    expect(stateService.consume).not.toHaveBeenCalledWith('state-1');
    expect(completionService.completeLink).not.toHaveBeenCalled();
  });

  it('rejects a mismatched state cookie without consuming the state', async () => {
    const response = await fetch(
      `${baseUrl}/zalo/oauth/callback?code=auth-code&state=state-1`,
      { headers: { cookie: '__Host-zalo_oauth_state=different-state' } },
    );

    expect(await response.json()).toEqual(
      expect.objectContaining({ success: false }),
    );
    expect(stateService.consume).not.toHaveBeenCalledWith('state-1');
    expect(completionService.completeLink).not.toHaveBeenCalled();
  });
});
