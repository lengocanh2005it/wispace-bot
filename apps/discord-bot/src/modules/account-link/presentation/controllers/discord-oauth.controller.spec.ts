import { DiscordOauthController } from './discord-oauth.controller';

function mockDeps() {
  return {
    configService: {
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
    },
    completionService: { completeLink: jest.fn() },
    stateService: { create: jest.fn(), consume: jest.fn() },
  };
}

describe('DiscordOauthController', () => {
  describe('getOAuthUrl', () => {
    it('generates a state and includes it in the OAuth URL', async () => {
      const deps = mockDeps();
      deps.stateService.create.mockResolvedValue('random-state-123');
      const controller = new DiscordOauthController(
        deps.configService as never,
        deps.completionService as never,
        deps.stateService as never,
      );

      const res = {
        json: jest.fn(),
        setHeader: jest.fn(),
        cookie: jest.fn(),
      } as never;
      await controller.getOAuthUrl('link-token-abc', res);

      expect(deps.stateService.create).toHaveBeenCalledWith('link-token-abc');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('state=random-state-123'),
        }),
      );
    });

    it('sets Cache-Control: no-store on the response', async () => {
      const deps = mockDeps();
      deps.stateService.create.mockResolvedValue('state-xyz');
      const controller = new DiscordOauthController(
        deps.configService as never,
        deps.completionService as never,
        deps.stateService as never,
      );

      const res = {
        json: jest.fn(),
        setHeader: jest.fn(),
        cookie: jest.fn(),
      } as never;
      await controller.getOAuthUrl('token-abc', res);

      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    });

    it('sets browser-binding cookie with the state nonce (#348)', async () => {
      const deps = mockDeps();
      deps.stateService.create.mockResolvedValue('state-abc');
      const controller = new DiscordOauthController(
        deps.configService as never,
        deps.completionService as never,
        deps.stateService as never,
      );

      const res = {
        json: jest.fn(),
        setHeader: jest.fn(),
        cookie: jest.fn(),
      } as never;
      await controller.getOAuthUrl('token-abc', res);

      expect(res.cookie).toHaveBeenCalledWith(
        '__Host-discord_oauth_state',
        'state-abc',
        expect.objectContaining({
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
        }),
      );
    });

    it('returns empty url when linkToken is missing', async () => {
      const deps = mockDeps();
      const controller = new DiscordOauthController(
        deps.configService as never,
        deps.completionService as never,
        deps.stateService as never,
      );

      const res = { json: jest.fn() } as never;
      await controller.getOAuthUrl(undefined, res);

      expect(deps.stateService.create).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ url: '' });
    });
  });

  describe('callback', () => {
    it('consumes state and completes link when cookie matches (#348)', async () => {
      const deps = mockDeps();
      deps.stateService.consume.mockResolvedValue({
        linkToken: 'link-token-123',
      });
      deps.completionService.completeLink.mockResolvedValue('success');
      const controller = new DiscordOauthController(
        deps.configService as never,
        deps.completionService as never,
        deps.stateService as never,
      );

      const res = {
        setHeader: jest.fn(),
        redirect: jest.fn(),
        clearCookie: jest.fn(),
      } as never;
      const req = {
        headers: { cookie: '__Host-discord_oauth_state=state-nonce' },
      };
      await controller.callback(
        'auth-code',
        'state-nonce',
        undefined,
        res,
        req,
      );

      expect(deps.stateService.consume).toHaveBeenCalledWith('state-nonce');
      expect(deps.completionService.completeLink).toHaveBeenCalledWith(
        'auth-code',
        'link-token-123',
      );
      expect(res.clearCookie).toHaveBeenCalledWith(
        '__Host-discord_oauth_state',
      );
    });

    it('rejects callback when cookie is missing (#348)', async () => {
      const deps = mockDeps();
      const controller = new DiscordOauthController(
        deps.configService as never,
        deps.completionService as never,
        deps.stateService as never,
      );

      const res = {
        setHeader: jest.fn(),
        redirect: jest.fn(),
        clearCookie: jest.fn(),
      } as never;
      const req = { headers: {} };
      await controller.callback(
        'auth-code',
        'state-nonce',
        undefined,
        res,
        req,
      );

      expect(deps.stateService.consume).not.toHaveBeenCalled();
      expect(deps.completionService.completeLink).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith('https://landing.example.com');
    });

    it('rejects callback when cookie mismatches state (#348)', async () => {
      const deps = mockDeps();
      const controller = new DiscordOauthController(
        deps.configService as never,
        deps.completionService as never,
        deps.stateService as never,
      );

      const res = {
        setHeader: jest.fn(),
        redirect: jest.fn(),
        clearCookie: jest.fn(),
      } as never;
      const req = {
        headers: { cookie: '__Host-discord_oauth_state=different-state' },
      };
      await controller.callback(
        'auth-code',
        'state-nonce',
        undefined,
        res,
        req,
      );

      expect(deps.stateService.consume).not.toHaveBeenCalled();
      expect(deps.completionService.completeLink).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith('https://landing.example.com');
    });

    it('returns error when state is invalid or expired', async () => {
      const deps = mockDeps();
      deps.stateService.consume.mockResolvedValue(undefined);
      const controller = new DiscordOauthController(
        deps.configService as never,
        deps.completionService as never,
        deps.stateService as never,
      );

      const res = {
        setHeader: jest.fn(),
        redirect: jest.fn(),
        clearCookie: jest.fn(),
      } as never;
      const req = {
        headers: { cookie: '__Host-discord_oauth_state=bad-state' },
      };
      await controller.callback('auth-code', 'bad-state', undefined, res, req);

      expect(deps.completionService.completeLink).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith('https://landing.example.com');
    });
  });
});
