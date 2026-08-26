import { ConfigService } from '@nestjs/config';
import { ZaloOauthController } from './zalo-oauth.controller';
import { ZaloAccountLinkService } from '../../application/services/zalo-account-link.service';
import { ZaloOauthStateService } from '../../application/services/zalo-oauth-state.service';
import {
  ZaloLinkCompletionService,
  ZaloLinkTokenRejectedError,
} from '../../application/services/zalo-link-completion.service';

function buildConfig(): ConfigService {
  return {
    getOrThrow: (key: string) =>
      ({
        ZALO_APP_ID: 'app-1',
        ZALO_OAUTH_REDIRECT_URI:
          'https://zalo-bot.example.com/zalo/oauth/callback',
      })[key],
  } as unknown as ConfigService;
}

function buildRes() {
  return {
    redirect: jest.fn(),
    json: jest.fn(),
    setHeader: jest.fn(),
    cookie: jest.fn(),
    clearCookie: jest.fn(),
  };
}

describe('ZaloOauthController', () => {
  it('GET /authorize sets Cache-Control: no-store before redirect', async () => {
    const controller = new ZaloOauthController(
      buildConfig(),
      {
        buildPkcePair: jest.fn().mockReturnValue({
          codeVerifier: 'v',
          codeChallenge: 'c',
        }),
        exchangeCodeForZaloUser: jest.fn(),
        upsertLink: jest.fn(),
        findUserIdByZaloId: jest.fn(),
      } as unknown as ZaloAccountLinkService,
      {
        create: jest.fn().mockResolvedValue('s'),
        consume: jest.fn(),
      } as unknown as ZaloOauthStateService,
      { completeLink: jest.fn() } as unknown as ZaloLinkCompletionService,
    );

    const res = buildRes();
    await controller.authorize('token', res);

    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.redirect).toHaveBeenCalled();
  });

  it('GET /authorize redirects to Zalo Login with a code_challenge and state', async () => {
    const buildPkcePair = jest.fn().mockReturnValue({
      codeVerifier: 'verifier-1',
      codeChallenge: 'challenge-1',
    });
    const create = jest.fn().mockResolvedValue('state-1');

    const controller = new ZaloOauthController(
      buildConfig(),
      {
        buildPkcePair,
        exchangeCodeForZaloUser: jest.fn(),
        upsertLink: jest.fn(),
        findUserIdByZaloId: jest.fn(),
      } as unknown as ZaloAccountLinkService,
      { create, consume: jest.fn() } as unknown as ZaloOauthStateService,
      { completeLink: jest.fn() } as unknown as ZaloLinkCompletionService,
    );

    const res = buildRes();
    await controller.authorize('wispace-link-token', res);

    expect(create).toHaveBeenCalledWith('verifier-1', 'wispace-link-token');
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('code_challenge=challenge-1'),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('state=state-1'),
    );
    expect(res.redirect).not.toHaveBeenCalledWith(
      expect.stringContaining('wispace-link-token'),
    );
  });

  it('GET /authorize sets browser-binding cookie with the state nonce (#348)', async () => {
    const controller = new ZaloOauthController(
      buildConfig(),
      {
        buildPkcePair: jest.fn().mockReturnValue({
          codeVerifier: 'v',
          codeChallenge: 'c',
        }),
        exchangeCodeForZaloUser: jest.fn(),
        upsertLink: jest.fn(),
        findUserIdByZaloId: jest.fn(),
      } as unknown as ZaloAccountLinkService,
      {
        create: jest.fn().mockResolvedValue('s'),
        consume: jest.fn(),
      } as unknown as ZaloOauthStateService,
      { completeLink: jest.fn() } as unknown as ZaloLinkCompletionService,
    );

    const res = {
      redirect: jest.fn(),
      json: jest.fn(),
      setHeader: jest.fn(),
      cookie: jest.fn(),
    } as never;
    await controller.authorize('token', res);

    expect(res.cookie).toHaveBeenCalledWith(
      '__Host-zalo_oauth_state',
      's',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
      }),
    );
  });

  it('GET /callback links the account when cookie matches (#348)', async () => {
    const consume = jest.fn().mockResolvedValue({
      codeVerifier: 'verifier-1',
      linkToken: 'stored-link-token',
    });
    const completeLink = jest.fn().mockResolvedValue(undefined);

    const controller = new ZaloOauthController(
      buildConfig(),
      {
        buildPkcePair: jest.fn(),
        exchangeCodeForZaloUser: jest.fn(),
        upsertLink: jest.fn(),
        findUserIdByZaloId: jest.fn(),
      } as unknown as ZaloAccountLinkService,
      { create: jest.fn(), consume } as unknown as ZaloOauthStateService,
      { completeLink } as unknown as ZaloLinkCompletionService,
    );

    const res = buildRes();
    res.clearCookie = jest.fn();
    const req = {
      headers: { cookie: '__Host-zalo_oauth_state=state-1' },
    };
    await controller.callback('auth-code', 'state-1', res, req);

    expect(consume).toHaveBeenCalledWith('state-1');
    expect(completeLink).toHaveBeenCalledWith(
      'auth-code',
      'verifier-1',
      'stored-link-token',
    );
    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(res.clearCookie).toHaveBeenCalledWith('__Host-zalo_oauth_state');
  });

  it('GET /callback rejects when cookie is missing (#348)', async () => {
    const consume = jest.fn();

    const controller = new ZaloOauthController(
      buildConfig(),
      {
        buildPkcePair: jest.fn(),
        exchangeCodeForZaloUser: jest.fn(),
        upsertLink: jest.fn(),
        findUserIdByZaloId: jest.fn(),
      } as unknown as ZaloAccountLinkService,
      { create: jest.fn(), consume } as unknown as ZaloOauthStateService,
      { completeLink: jest.fn() } as unknown as ZaloLinkCompletionService,
    );

    const res = buildRes();
    const req = { headers: {} };
    await controller.callback('auth-code', 'state-1', res, req);

    expect(consume).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });

  it('GET /callback rejects when cookie mismatches state (#348)', async () => {
    const consume = jest.fn();

    const controller = new ZaloOauthController(
      buildConfig(),
      {
        buildPkcePair: jest.fn(),
        exchangeCodeForZaloUser: jest.fn(),
        upsertLink: jest.fn(),
        findUserIdByZaloId: jest.fn(),
      } as unknown as ZaloAccountLinkService,
      { create: jest.fn(), consume } as unknown as ZaloOauthStateService,
      { completeLink: jest.fn() } as unknown as ZaloLinkCompletionService,
    );

    const res = buildRes();
    const req = {
      headers: { cookie: '__Host-zalo_oauth_state=different-state' },
    };
    await controller.callback('auth-code', 'state-1', res, req);

    expect(consume).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });

  it('GET /callback maps a rejected WISPACE token to the invalid-link message', async () => {
    const consume = jest.fn().mockResolvedValue({
      codeVerifier: 'verifier-1',
      linkToken: 'stored-link-token',
    });
    const completeLink = jest
      .fn()
      .mockRejectedValue(new ZaloLinkTokenRejectedError());

    const controller = new ZaloOauthController(
      buildConfig(),
      {
        buildPkcePair: jest.fn(),
        exchangeCodeForZaloUser: jest.fn(),
        upsertLink: jest.fn(),
        findUserIdByZaloId: jest.fn(),
      } as unknown as ZaloAccountLinkService,
      { create: jest.fn(), consume } as unknown as ZaloOauthStateService,
      { completeLink } as unknown as ZaloLinkCompletionService,
    );

    const res = buildRes();
    const req = {
      headers: { cookie: '__Host-zalo_oauth_state=state-1' },
    };
    await controller.callback('auth-code', 'state-1', res, req);

    const lastCall = res.json.mock.calls[res.json.mock.calls.length - 1] as
      | [unknown]
      | undefined;
    const payload = lastCall?.[0] as
      | { success: boolean; message: string }
      | undefined;
    expect(payload?.success).toBe(false);
    expect(payload?.message).toContain('hết hạn');
  });

  it('GET /callback returns an error when the PKCE state is missing/expired', async () => {
    const consume = jest.fn().mockResolvedValue(undefined);

    const controller = new ZaloOauthController(
      buildConfig(),
      {
        buildPkcePair: jest.fn(),
        exchangeCodeForZaloUser: jest.fn(),
        upsertLink: jest.fn(),
        findUserIdByZaloId: jest.fn(),
      } as unknown as ZaloAccountLinkService,
      { create: jest.fn(), consume } as unknown as ZaloOauthStateService,
      { completeLink: jest.fn() } as unknown as ZaloLinkCompletionService,
    );

    const res = buildRes();
    const req = {
      headers: { cookie: '__Host-zalo_oauth_state=state-1' },
    };
    await controller.callback('auth-code', 'state-1', res, req);

    const jsonMock = res.json;
    const lastCall = jsonMock.mock.calls[jsonMock.mock.calls.length - 1] as
      | [unknown]
      | undefined;
    const payload = lastCall?.[0] as
      | { success: boolean; message: string }
      | undefined;
    expect(payload?.success).toBe(false);
    expect(payload?.message).toContain('hết hạn');
  });
});
