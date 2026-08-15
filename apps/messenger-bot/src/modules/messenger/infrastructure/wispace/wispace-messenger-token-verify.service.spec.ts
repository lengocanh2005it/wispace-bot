/* eslint-disable no-control-regex -- tests assert control-char stripping */
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { WispaceMessengerTokenVerifyService } from './wispace-messenger-token-verify.service';

describe('WispaceMessengerTokenVerifyService', () => {
  const verifyUrl =
    'https://backend.aihubproduction.com/api/User/verify-token-url';

  const createService = (env: Record<string, string | undefined> = {}) => {
    const configService = {
      get: (key: string) =>
        ({
          WISPACE_API_VERIFY_TOKEN_URL: verifyUrl,
          WISPACE_INTERNAL_KEY: 'internal-secret',
          ...env,
        })[key],
    } as ConfigService;

    return new WispaceMessengerTokenVerifyService(configService);
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POSTs token, value, platform with X-Internal-Key', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () =>
        Promise.resolve(
          JSON.stringify({
            success: true,
            userId: 143,
            username: 'Tab Valenskyeee',
            email: 'billbonny29@gmail.com',
          }),
        ),
    } as Response);

    const service = createService();
    const result = await service.verifyMessengerToken('psid-1', 'token-abc');

    expect(result).toEqual({
      valid: true,
      userId: 143,
      topic: 'IELTS',
      cadence: 'WEEKLY',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      verifyUrl,
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': 'internal-secret',
        },
        body: JSON.stringify({
          token: 'token-abc',
          value: 'psid-1',
          platform: 'messenger',
        }),
      }),
    );
  });

  it('maps verify failure reason from non-2xx response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      text: () =>
        Promise.resolve(JSON.stringify({ success: false, reason: 'USED' })),
    } as Response);

    const service = createService();
    const result = await service.verifyMessengerToken('psid-1', 'token-abc');

    expect(result).toEqual({ valid: false, reason: 'USED' });
  });

  it('maps success false on HTTP 200 to failure', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () =>
        Promise.resolve(JSON.stringify({ success: false, reason: 'EXPIRED' })),
    } as Response);

    const service = createService();
    const result = await service.verifyMessengerToken('psid-1', 'token-abc');

    expect(result).toEqual({ valid: false, reason: 'EXPIRED' });
  });

  it('#108: never logs token material or raw usernames', async () => {
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () =>
        Promise.resolve(
          JSON.stringify({
            success: true,
            userId: 143,
            username: 'SuperSecretName123',
          }),
        ),
    } as Response);

    const service = createService();
    await service.verifyMessengerToken('psid-1', 'secret-token-abc');

    const logCalls = logSpy.mock.calls.map((call) => String(call[0]));
    for (const line of logCalls) {
      expect(line).not.toContain('token=');
      expect(line).not.toContain('secret-token-abc');
      expect(line).not.toContain('SuperSecretName123');
    }
    expect(
      logCalls.some((line) => line.includes(`username=Supe\u2026e123`)),
    ).toBe(true);
  });

  it('#108: strips control characters from raw usernames in logs', async () => {
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () =>
        Promise.resolve(
          JSON.stringify({
            success: true,
            userId: 143,
            username: 'Hacker\u0007\u001b[2JName',
          }),
        ),
    } as Response);

    const service = createService();
    await service.verifyMessengerToken('psid-1', 'token-abc');

    const logCalls = logSpy.mock.calls.map((call) => String(call[0]));
    for (const line of logCalls) {
      expect(line).not.toMatch(/[\u0000-\u001F\u007F]/);
    }
  });
});
