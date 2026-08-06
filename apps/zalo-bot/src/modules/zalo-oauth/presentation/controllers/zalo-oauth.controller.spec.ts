import { ConfigService } from '@nestjs/config';
import { ZaloOauthController } from './zalo-oauth.controller';
import { ZaloAccountLinkService } from '../../application/services/zalo-account-link.service';
import { ZaloOauthStateService } from '../../application/services/zalo-oauth-state.service';
import { WispaceZaloTokenVerifyService } from '../../infrastructure/wispace/wispace-zalo-token-verify.service';

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
  return { redirect: jest.fn(), json: jest.fn() };
}

describe('ZaloOauthController', () => {
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
      { verifyToken: jest.fn() } as unknown as WispaceZaloTokenVerifyService,
      { sendText: jest.fn() },
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

  it('GET /callback links the account and sends a welcome message on success', async () => {
    const consume = jest.fn().mockResolvedValue({
      codeVerifier: 'verifier-1',
      linkToken: 'stored-link-token',
    });
    const exchangeCodeForZaloUser = jest
      .fn()
      .mockResolvedValue({ id: 'zalo-user-1', name: 'A' });
    const verifyToken = jest
      .fn()
      .mockResolvedValue({ valid: true, userId: 42 });
    const upsertLink = jest.fn().mockResolvedValue(undefined);
    const sendText = jest.fn().mockResolvedValue(undefined);

    const controller = new ZaloOauthController(
      buildConfig(),
      {
        buildPkcePair: jest.fn(),
        exchangeCodeForZaloUser,
        upsertLink,
        findUserIdByZaloId: jest.fn(),
      } as unknown as ZaloAccountLinkService,
      { create: jest.fn(), consume } as unknown as ZaloOauthStateService,
      { verifyToken } as unknown as WispaceZaloTokenVerifyService,
      { sendText },
    );

    const res = buildRes();
    await controller.callback('auth-code', 'state-1', res);

    expect(consume).toHaveBeenCalledWith('state-1');
    expect(exchangeCodeForZaloUser).toHaveBeenCalledWith(
      'auth-code',
      'verifier-1',
    );
    expect(verifyToken).toHaveBeenCalledWith(
      'stored-link-token',
      'zalo-user-1',
    );
    expect(upsertLink).toHaveBeenCalledWith(42, 'zalo-user-1');
    expect(sendText).toHaveBeenCalledWith(
      'zalo-user-1',
      expect.stringContaining('liên kết'),
    );
    expect(res.json).toHaveBeenCalledWith({ success: true });
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
      { verifyToken: jest.fn() } as unknown as WispaceZaloTokenVerifyService,
      { sendText: jest.fn() },
    );

    const res = buildRes();
    await controller.callback('auth-code', 'state-1', res);

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
