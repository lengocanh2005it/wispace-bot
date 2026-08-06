/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest.fn() mock of global.fetch */
import { ConfigService } from '@nestjs/config';
import { WispaceTokenVerifyService } from './wispace-token-verify.service';

const CONFIG_VALUES: Record<string, string> = {
  WISPACE_API_VERIFY_TOKEN_URL:
    'https://backend.example.com/api/User/verify-token-url',
  WISPACE_INTERNAL_KEY: 'internal-key',
};

function buildConfigService(): ConfigService {
  return {
    get: (key: string) => CONFIG_VALUES[key],
  } as unknown as ConfigService;
}

describe('WispaceTokenVerifyService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it.each(['discord', 'zalo'] as const)(
    'sends token, value and platform=%s to the verify URL',
    async (platform) => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ userId: 143 })),
      });
      global.fetch = fetchMock;

      const service = new WispaceTokenVerifyService(
        buildConfigService(),
        platform,
      );
      const result = await service.verifyToken(
        'link-token',
        `${platform}-user-1`,
      );

      expect(result).toEqual({ valid: true, userId: 143 });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://backend.example.com/api/User/verify-token-url',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'X-Internal-Key': 'internal-key',
          }),
          body: JSON.stringify({
            token: 'link-token',
            value: `${platform}-user-1`,
            platform,
          }),
        }),
      );
    },
  );

  it.each(['discord', 'zalo'] as const)(
    'returns a failure reason from a non-ok response (%s)',
    async (platform) => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: () => Promise.resolve(JSON.stringify({ reason: 'NOT_FOUND' })),
      });

      const service = new WispaceTokenVerifyService(
        buildConfigService(),
        platform,
      );

      await expect(
        service.verifyToken('bad-token', `${platform}-user-1`),
      ).resolves.toEqual({ valid: false, reason: 'NOT_FOUND' });
    },
  );

  it.each([
    ['EXPIRED', 'EXPIRED'],
    ['USED', 'USED'],
    ['INVALID_FORMAT', 'invalid_format'],
  ])('parses %s failure reason from %s', async (reason, rawValue) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: () => Promise.resolve(JSON.stringify({ reason: rawValue })),
    });

    const service = new WispaceTokenVerifyService(
      buildConfigService(),
      'discord',
    );

    await expect(
      service.verifyToken('bad-token', 'discord-user-1'),
    ).resolves.toEqual({ valid: false, reason });
  });

  it('reads the failure reason from the error field when reason is absent', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: () => Promise.resolve(JSON.stringify({ error: 'USED' })),
    });

    const service = new WispaceTokenVerifyService(
      buildConfigService(),
      'discord',
    );

    await expect(
      service.verifyToken('bad-token', 'discord-user-1'),
    ).resolves.toEqual({ valid: false, reason: 'USED' });
  });

  it('returns NOT_FOUND when an ok response has success=false', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ success: false })),
    });

    const service = new WispaceTokenVerifyService(buildConfigService(), 'zalo');

    await expect(service.verifyToken('token', 'zalo-user-1')).resolves.toEqual({
      valid: false,
      reason: 'NOT_FOUND',
    });
  });

  it('throws when the verify URL is unset', async () => {
    const config = {
      get: () => undefined,
    } as unknown as ConfigService;
    const service = new WispaceTokenVerifyService(config, 'discord');

    await expect(
      service.verifyToken('token', 'discord-user-1'),
    ).rejects.toThrow('WISPACE_API_VERIFY_TOKEN_URL must be set');
  });

  it('throws when an ok response is missing userId', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ foo: 'bar' })),
    });

    const service = new WispaceTokenVerifyService(
      buildConfigService(),
      'discord',
    );

    await expect(
      service.verifyToken('token', 'discord-user-1'),
    ).rejects.toThrow('missing userId in success response');
  });
});
