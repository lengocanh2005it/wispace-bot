/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest.fn() mock of global.fetch */
/* eslint-disable no-control-regex -- tests assert control-char stripping */
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
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

  it('fails closed when the configured verify URL is unsafe', async () => {
    const configWithUnsafeUrl: ConfigService = {
      get: (key: string) =>
        key === 'WISPACE_API_VERIFY_TOKEN_URL'
          ? 'http://backend.example.com/api/verify-token'
          : CONFIG_VALUES[key],
    } as unknown as ConfigService;

    const service = new WispaceTokenVerifyService(configWithUnsafeUrl, 'zalo');

    await expect(
      service.verifyToken('link-token', 'zalo-user-1'),
    ).rejects.toThrow('must use HTTPS');
  });

  it('fails closed when the verify host is not in WISPACE_ALLOWED_HOSTS', async () => {
    const configWithAllowlist: ConfigService = {
      get: (key: string) =>
        key === 'WISPACE_ALLOWED_HOSTS'
          ? 'allowed.example.com'
          : CONFIG_VALUES[key],
    } as unknown as ConfigService;

    const service = new WispaceTokenVerifyService(configWithAllowlist, 'zalo');

    await expect(
      service.verifyToken('link-token', 'zalo-user-1'),
    ).rejects.toThrow('is not in WISPACE_ALLOWED_HOSTS');
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

  it('#108: never logs link-token material, including prefixes', async () => {
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ userId: 143 })),
    });

    const service = new WispaceTokenVerifyService(buildConfigService(), 'zalo');
    await service.verifyToken('secret-link-token-abc', 'zalo-user-1');

    const logCalls = logSpy.mock.calls.map((call) => String(call[0]));
    expect(logCalls.some((line) => line.includes('token='))).toBe(false);
    for (const line of logCalls) {
      expect(line).not.toContain('secret-link-token-abc');
      expect(line).not.toContain('link-token');
    }
  });

  it('#292: upstream error body payload is not exposed in the error message', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () =>
        Promise.resolve(
          JSON.stringify({ raw: 'boom\u001b[2J\u0000 secret-payload' }),
        ),
    });

    const service = new WispaceTokenVerifyService(
      buildConfigService(),
      'discord',
    );

    let message = '';
    await service
      .verifyToken('bad-token', 'discord-user-1')
      .catch((error: unknown) => {
        message = error instanceof Error ? error.message : String(error);
      });

    expect(message).toBe(
      'WISPACE verify-discord-token failed: HTTP 500 Internal Server Error',
    );
    expect(message).not.toContain('secret-payload');
    expect(message).not.toMatch(/[\u0000-\u001F\u007F]/);
  });
});
