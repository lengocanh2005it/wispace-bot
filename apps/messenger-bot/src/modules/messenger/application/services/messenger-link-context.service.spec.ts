import { MessengerLinkContextService } from './messenger-link-context.service';
import { WispaceMessengerTokenVerifyService } from '../../infrastructure/wispace/wispace-messenger-token-verify.service';

describe('MessengerLinkContextService', () => {
  const createService = (
    verifyImpl: WispaceMessengerTokenVerifyService['verifyMessengerToken'],
    verifyRecordRepoOverrides?: Record<string, jest.Mock>,
  ) => {
    const verifyService = {
      verifyMessengerToken: verifyImpl,
    } as WispaceMessengerTokenVerifyService;

    const verifyRecordRepository = {
      findByRefFingerprint: jest.fn().mockResolvedValue(null),
      recordVerify: jest.fn().mockResolvedValue({ intentGeneration: '1' }),
      consumeRecord: jest.fn().mockResolvedValue(undefined),
      listStaleRecords: jest.fn().mockResolvedValue([]),
      discardRecord: jest.fn().mockResolvedValue(undefined),
      ...verifyRecordRepoOverrides,
    };

    const service = new MessengerLinkContextService(
      verifyService,
      verifyRecordRepository as never,
    );

    return { service, verifyRecordRepository };
  };

  it('verifies opaque token via WISPACE', async () => {
    const { service, verifyRecordRepository } = createService(() =>
      Promise.resolve({
        valid: true as const,
        userId: 143,
        topic: 'IELTS',
        cadence: 'WEEKLY' as const,
      }),
    );

    const outcome = await service.resolveFromRef('psid-1', {
      ref: 'opaque-token',
    });

    expect(verifyRecordRepository.recordVerify).toHaveBeenCalledWith(
      expect.objectContaining({
        psid: 'psid-1',
        userId: 143,
        topic: 'IELTS',
        cadence: 'WEEKLY',
        refFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(outcome.intentGeneration).toBe('1');
    expect(outcome.context).toEqual({
      ref: 'opaque-token',
      userId: 143,
      topic: 'IELTS',
      cadence: 'WEEKLY',
    });
  });

  it('#384: persists the durable verify intent after successful verification', async () => {
    const { service, verifyRecordRepository } = createService(() =>
      Promise.resolve({
        valid: true as const,
        userId: 143,
        topic: 'IELTS',
        cadence: 'WEEKLY' as const,
      }),
    );

    await service.resolveFromRef('psid-1', { ref: 'opaque-token' });

    expect(verifyRecordRepository.recordVerify).toHaveBeenCalledWith(
      expect.objectContaining({
        psid: 'psid-1',
        userId: 143,
        topic: 'IELTS',
        cadence: 'WEEKLY',
      }),
    );
  });

  it('#384: does not persist an intent when verification fails', async () => {
    const { service, verifyRecordRepository } = createService(() =>
      Promise.resolve({ valid: false as const, reason: 'EXPIRED' }),
    );

    await service.resolveFromRef('psid-1', { ref: 'opaque-token' });

    expect(verifyRecordRepository.recordVerify).not.toHaveBeenCalled();
  });

  it('#821: retries intent persistence before failing closed', async () => {
    const recordVerify = jest
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue({ intentGeneration: '2' });
    const { service, verifyRecordRepository } = createService(
      () =>
        Promise.resolve({
          valid: true as const,
          userId: 143,
          topic: 'IELTS',
          cadence: 'WEEKLY' as const,
        }),
      {
        recordVerify,
      },
    );

    const outcome = await service.resolveFromRef('psid-1', {
      ref: 'opaque-token',
    });

    expect(recordVerify).toHaveBeenCalledTimes(2);
    expect(outcome.intentGeneration).toBe('2');
    expect(verifyRecordRepository.findByRefFingerprint).toHaveBeenCalled();
  });

  it('#821: returns handoff failure after bounded persistence retries', async () => {
    const { service } = createService(
      () =>
        Promise.resolve({
          valid: true as const,
          userId: 143,
          topic: 'IELTS',
          cadence: 'WEEKLY' as const,
        }),
      {
        recordVerify: jest.fn().mockRejectedValue(new Error('db down')),
      },
    );

    await expect(
      service.resolveFromRef('psid-1', { ref: 'opaque-token' }),
    ).resolves.toEqual({ handoffFailure: true });
  });

  it('#821: does not consume a token when intent lookup is unavailable', async () => {
    const verify = jest.fn();
    const { service } = createService(verify, {
      findByRefFingerprint: jest.fn().mockRejectedValue(new Error('db down')),
    });

    await expect(
      service.resolveFromRef('psid-1', { ref: 'opaque-token' }),
    ).resolves.toEqual({ handoffFailure: true });
    expect(verify).not.toHaveBeenCalled();
  });

  it('#821: reuses a pending intent without verifying the token again', async () => {
    const verify = jest.fn();
    const { service, verifyRecordRepository } = createService(verify, {
      findByRefFingerprint: jest.fn().mockResolvedValue({
        psid: 'psid-1',
        userId: 143,
        topic: 'IELTS Writing',
        cadence: 'DAILY',
        refFingerprint: 'fingerprint',
        intentGeneration: '7',
        status: 'pending',
        verifiedAt: new Date(),
      }),
    });

    const outcome = await service.resolveFromRef('psid-1', {
      ref: 'opaque-token',
      topic: 'ignored-topic',
      cadence: 'MONTHLY',
    });

    expect(verify).not.toHaveBeenCalled();
    expect(verifyRecordRepository.recordVerify).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      context: {
        ref: 'opaque-token',
        userId: 143,
        topic: 'IELTS Writing',
        cadence: 'DAILY',
      },
      intentGeneration: '7',
      intentState: 'pending',
    });
  });

  it('#821: reports a committed matching intent without relinking', async () => {
    const verify = jest.fn();
    const { service } = createService(verify, {
      findByRefFingerprint: jest.fn().mockResolvedValue({
        psid: 'psid-1',
        userId: 143,
        topic: 'IELTS',
        cadence: 'WEEKLY',
        refFingerprint: 'fingerprint',
        intentGeneration: '8',
        status: 'committed',
        verifiedAt: new Date(),
      }),
    });

    const outcome = await service.resolveFromRef('psid-1', {
      ref: 'opaque-token',
    });

    expect(verify).not.toHaveBeenCalled();
    expect(outcome.intentState).toBe('committed');
    expect(outcome.intentGeneration).toBe('8');
  });

  it('returns context with topic/cadence fallbacks from the event', async () => {
    const verify = jest.fn(() =>
      Promise.resolve({
        valid: true as const,
        userId: 143,
        topic: 'IELTS',
        cadence: 'WEEKLY' as const,
      }),
    );

    const { service } = createService(verify);

    const outcome = await service.resolveFromRef('psid-1', {
      ref: 'opaque-token',
    });

    expect(verify).toHaveBeenCalledWith('psid-1', 'opaque-token');
    expect(outcome.context).toEqual({
      ref: 'opaque-token',
      userId: 143,
      topic: 'IELTS',
      cadence: 'WEEKLY',
    });
  });

  it('does not parse numeric ref as userId without verify', async () => {
    const verify = jest.fn(() =>
      Promise.resolve({
        valid: false as const,
        reason: 'NOT_FOUND' as const,
      }),
    );

    const { service } = createService(verify);

    const outcome = await service.resolveFromRef('psid-1', { ref: '143' });

    expect(verify).toHaveBeenCalledWith('psid-1', '143');
    expect(outcome).toEqual({ verifyFailureReason: 'NOT_FOUND' });
  });

  it('returns verify failure reason without context', async () => {
    const verify = jest.fn(() =>
      Promise.resolve({
        valid: false as const,
        reason: 'EXPIRED' as const,
      }),
    );

    const { service } = createService(verify);

    const outcome = await service.resolveFromRef('psid-1', {
      ref: 'opaque-token',
    });

    expect(outcome).toEqual({ verifyFailureReason: 'EXPIRED' });
  });
});
