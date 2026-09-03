import type { BurstCounterPort, ChatRateLimitRepositoryPort } from './types';
import { ChatRateLimitCore } from './chat-rate-limit-core.service';

describe('ChatRateLimitCore', () => {
  const buildRepository = (
    reserve: ChatRateLimitRepositoryPort['reserveFreeFormSlotInTransaction'],
  ): ChatRateLimitRepositoryPort =>
    ({
      getDailyUsageCount: jest.fn().mockResolvedValue(0),
      reserveFreeFormSlotInTransaction: jest.fn(reserve),
      refundReservedSlot: jest.fn().mockResolvedValue(false),
      completeReservedSlot: jest.fn().mockResolvedValue(true),
      markDeliveredSlot: jest.fn().mockResolvedValue(true),
      recoverIdempotencyForRetry: jest.fn().mockResolvedValue('not_found'),
      recoverAllStuckReserved: jest.fn().mockResolvedValue([]),
    }) as unknown as ChatRateLimitRepositoryPort;

  const buildCounter = (
    result: Awaited<ReturnType<BurstCounterPort['tryReserveBurst']>>,
  ): BurstCounterPort =>
    ({
      getBurstCount: jest.fn().mockResolvedValue(result.count),
      tryReserveBurst: jest.fn().mockResolvedValue(result),
      releaseReservation: jest.fn().mockResolvedValue(undefined),
    }) as BurstCounterPort;

  const settings = {
    freeFormDailyLimit: 10,
    burstPerMinute: 2,
    timezone: 'UTC',
  };

  it('lets PostgreSQL make the final decision after an advisory burst reject', async () => {
    const repository = buildRepository(async () => ({
      status: 'reserved',
      freeFormCount: 1,
    }));
    const counter = buildCounter({
      allowed: false,
      count: 2,
      transactional: false,
    });
    const core = new ChatRateLimitCore(repository, counter, settings);

    const result = await core.reserveFreeFormSlot('user-1', {
      idempotencyKey: 'key-1',
    });

    expect(result.allowed).toBe(true);
    expect(repository.reserveFreeFormSlotInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        burstLimit: 2,
        burstSince: expect.any(Date),
        burstCountsRefunded: false,
      }),
    );
    expect(counter.releaseReservation).not.toHaveBeenCalled();
  });

  it('releases only an advisory reservation rejected by the PostgreSQL final check', async () => {
    const repository = buildRepository(async () => ({
      status: 'burst_limit_exceeded',
      count: 2,
    }));
    const counter = buildCounter({
      allowed: true,
      count: 1,
      transactional: false,
    });
    const core = new ChatRateLimitCore(repository, counter, settings);

    const result = await core.reserveFreeFormSlot('user-1', {
      idempotencyKey: 'key-2',
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: 'BURST_LIMIT',
      used: 2,
    });
    expect(counter.releaseReservation).toHaveBeenCalledWith('user-1');
  });

  it('does not release an advisory key when PostgreSQL accepted an advisory reject', async () => {
    const repository = buildRepository(async () => ({
      status: 'reserved',
      freeFormCount: 1,
    }));
    (repository.refundReservedSlot as jest.Mock).mockResolvedValue(true);
    const counter = buildCounter({
      allowed: false,
      count: 2,
      transactional: false,
    });
    const core = new ChatRateLimitCore(repository, counter, settings);

    const result = await core.reserveFreeFormSlot('user-1', {
      idempotencyKey: 'key-3',
    });
    await core.refundFreeFormSlot('user-1', result.usageDate, 'key-3');

    expect(result.allowed).toBe(true);
    expect(counter.releaseReservation).not.toHaveBeenCalled();
  });
});
