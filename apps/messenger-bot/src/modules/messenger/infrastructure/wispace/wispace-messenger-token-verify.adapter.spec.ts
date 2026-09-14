import { InternalServerErrorException } from '@nestjs/common';
import type { WispaceTokenVerifyService } from '@wispace/wispace-client';
import { WispaceMessengerTokenVerifyAdapter } from './wispace-messenger-token-verify.adapter';

describe('WispaceMessengerTokenVerifyAdapter', () => {
  function createAdapter(result: unknown) {
    const verifyToken = jest.fn().mockResolvedValue(result);
    const adapter = new WispaceMessengerTokenVerifyAdapter({
      verifyToken,
    } as unknown as WispaceTokenVerifyService);
    return { adapter, verifyToken };
  }

  it('delegates token/value in shared-client order and applies POC defaults', async () => {
    const { adapter, verifyToken } = createAdapter({
      valid: true,
      userId: 143,
      topic: ' ',
      cadence: ' ',
    });

    await expect(
      adapter.verifyMessengerToken('psid-1', 'token-abc'),
    ).resolves.toEqual({
      valid: true,
      userId: 143,
      topic: 'IELTS',
      cadence: 'WEEKLY',
    });
    expect(verifyToken).toHaveBeenCalledWith('token-abc', 'psid-1', undefined);
  });

  it('normalizes upstream Messenger metadata', async () => {
    const { adapter } = createAdapter({
      valid: true,
      userId: 143,
      topic: ' IELTS Writing ',
      cadence: 'monthly',
    });

    await expect(
      adapter.verifyMessengerToken('psid-1', 'token-abc'),
    ).resolves.toEqual({
      valid: true,
      userId: 143,
      topic: 'IELTS Writing',
      cadence: 'MONTHLY',
    });
  });

  it('fails closed for an invalid non-empty cadence', async () => {
    const { adapter } = createAdapter({
      valid: true,
      userId: 143,
      cadence: 'quarterly',
    });

    await expect(
      adapter.verifyMessengerToken('psid-1', 'token-abc'),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('passes verification failures through unchanged', async () => {
    const result = { valid: false as const, reason: 'EXPIRED' as const };
    const { adapter } = createAdapter(result);

    await expect(
      adapter.verifyMessengerToken('psid-1', 'token-abc'),
    ).resolves.toEqual(result);
  });

  it('forwards an optional AbortSignal', async () => {
    const signal = new AbortController().signal;
    const { adapter, verifyToken } = createAdapter({
      valid: true,
      userId: 143,
    });

    await adapter.verifyMessengerToken('psid-1', 'token-abc', { signal });

    expect(verifyToken).toHaveBeenCalledWith('token-abc', 'psid-1', {
      signal,
    });
  });
});
