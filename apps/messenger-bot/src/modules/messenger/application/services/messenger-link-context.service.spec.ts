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
      recordVerify: jest.fn().mockResolvedValue(undefined),
      consumeRecord: jest.fn().mockResolvedValue(undefined),
      listStaleRecords: jest.fn().mockResolvedValue([]),
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
      'psid-1',
      143,
    );
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
      'psid-1',
      143,
    );
  });

  it('#384: does not persist an intent when verification fails', async () => {
    const { service, verifyRecordRepository } = createService(() =>
      Promise.resolve({ valid: false as const, reason: 'EXPIRED' }),
    );

    await service.resolveFromRef('psid-1', { ref: 'opaque-token' });

    expect(verifyRecordRepository.recordVerify).not.toHaveBeenCalled();
  });

  it('#384: propagates intent-persistence failure so the handler fails closed', async () => {
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
    ).rejects.toThrow('db down');
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
