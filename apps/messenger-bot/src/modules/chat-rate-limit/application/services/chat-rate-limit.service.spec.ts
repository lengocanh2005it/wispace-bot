/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import { ConfigService } from '@nestjs/config';
import type { ChatQuotaRepositoryPort } from '../../domain/repositories/chat-quota.repository.port';
import type { ChatBurstCounterPort } from '../../domain/repositories/chat-burst-counter.port';
import type { MetricsService } from '@messenger/modules/metrics/metrics.service';
import { ChatRateLimitConfigService } from './chat-rate-limit-config.service';
import { ChatQuotaEventRecorderService } from './chat-quota-event-recorder.service';
import { ChatRateLimitService } from './chat-rate-limit.service';

describe('ChatRateLimitService', () => {
  const usageDatePattern = /^\d{4}-\d{2}-\d{2}$/;

  const createService = (
    enabled: boolean,
    dailyCount = 0,
    options: {
      burstCount?: number;
      whitelistPsids?: string;
      transactionalBurst?: boolean;
      burstCountsRefunded?: boolean;
    } = {},
  ) => {
    const config = {
      get: (key: string) => {
        const values: Record<string, string> = {
          CHAT_RATE_LIMIT_ENABLED: enabled ? 'true' : 'false',
          CHAT_FREE_FORM_DAILY_LIMIT: '15',
          CHAT_BURST_PER_MINUTE: '3',
          CHAT_USAGE_TIMEZONE: 'Asia/Ho_Chi_Minh',
          CHAT_RATE_LIMIT_WHITELIST_PSIDS: options.whitelistPsids ?? '',
          CHAT_QUOTA_REMAINING_HINT_THRESHOLD: '3',
          CHAT_IDEMPOTENCY_STUCK_RESERVED_MS: '600000',
          CHAT_MERGED_TEXT_MAX_CHARS: '4000',
          CHAT_BURST_COUNT_REFUNDED: options.burstCountsRefunded
            ? 'true'
            : 'false',
          CHAT_QUOTA_EVENTS_ENABLED: 'true',
        };
        return values[key];
      },
    } as ConfigService;

    const configService = new ChatRateLimitConfigService(config);
    let count = dailyCount;
    const idempotencyKeys = new Set<string>();

    let reserveCallCount = 0;
    const repository: ChatQuotaRepositoryPort = {
      getDailyUsageCount: jest.fn(() => Promise.resolve(count)),
      reserveFreeFormSlotInTransaction: jest.fn(
        ({ idempotencyKey, dailyLimit = 15 }) => {
          reserveCallCount += 1;
          if (idempotencyKeys.has(idempotencyKey)) {
            return Promise.resolve({ status: 'idempotency_conflict' });
          }

          if (count >= dailyLimit) {
            return Promise.resolve({ status: 'daily_limit_exceeded' });
          }

          idempotencyKeys.add(idempotencyKey);
          count += 1;
          return Promise.resolve({
            status: 'reserved',
            freeFormCount: count,
          });
        },
      ),
      refundReservedSlot: jest.fn(({ idempotencyKey }) => {
        if (!idempotencyKeys.has(idempotencyKey)) {
          return Promise.resolve(false);
        }

        idempotencyKeys.delete(idempotencyKey);
        count = Math.max(count - 1, 0);
        return Promise.resolve(true);
      }),
      markDeliveredSlot: jest.fn((idempotencyKey: string) =>
        Promise.resolve(idempotencyKeys.has(idempotencyKey)),
      ),
      completeReservedSlot: jest.fn((idempotencyKey: string) =>
        Promise.resolve(idempotencyKeys.has(idempotencyKey)),
      ),
      countRecentReservations: jest.fn(() =>
        Promise.resolve(options.burstCount ?? 0),
      ),
      recoverIdempotencyForRetry: jest.fn(() => Promise.resolve('not_found')),
      recoverAllStuckReserved: jest.fn(() => Promise.resolve([])),
      countStuckReserved: jest.fn(() => Promise.resolve(0)),
      countIdempotencyByStatusForUsageDate: jest.fn(() => Promise.resolve({})),
      countUsersAtOrAboveDailyLimit: jest.fn(() => Promise.resolve(0)),
    };

    const burstCounter: ChatBurstCounterPort = {
      getBurstCount: jest.fn(() => Promise.resolve(options.burstCount ?? 0)),
      tryReserveBurst: jest.fn((_psid: string, limit: number) => {
        const current = options.burstCount ?? 0;
        if (current >= limit) {
          return Promise.resolve({
            allowed: false,
            count: current,
            transactional: options.transactionalBurst ?? false,
          });
        }
        return Promise.resolve({
          allowed: true,
          count: current + 1,
          transactional: options.transactionalBurst ?? false,
        });
      }),
      releaseReservation: jest.fn(() => Promise.resolve()),
    };

    const quotaEventRecorder = {
      recordDeniedBestEffort: jest.fn(() => Promise.resolve()),
      isEnabled: jest.fn(() => true),
    } as unknown as ChatQuotaEventRecorderService;

    const metrics = {
      incQuotaDenied: jest.fn(),
    } as unknown as MetricsService;

    const service = new ChatRateLimitService(
      configService,
      repository,
      burstCounter,
      quotaEventRecorder,
      metrics,
    );

    return {
      service,
      repository,
      burstCounter,
      quotaEventRecorder,
      metrics,
      getCount: () => count,
      getReserveCallCount: () => reserveCallCount,
    };
  };

  it('reserves a slot when under the daily limit', async () => {
    const { service, getCount } = createService(true, 14);

    const result = await service.reserveFreeFormSlot('psid-1', {
      userId: 143,
      idempotencyKey: 'mid-1',
    });

    expect(result.allowed).toBe(true);
    expect(result.used).toBe(15);
    expect(result.limit).toBe(15);
    expect(result.remaining).toBe(0);
    expect(result.usageDate).toMatch(usageDatePattern);
    expect(getCount()).toBe(15);
  });

  it('denies reserve without incrementing when daily limit is reached', async () => {
    const { service, getCount, getReserveCallCount, burstCounter } =
      createService(true, 15);

    const result = await service.reserveFreeFormSlot('psid-1', {
      idempotencyKey: 'mid-1',
    });

    expect(result).toMatchObject({
      allowed: false,
      used: 15,
      limit: 15,
      remaining: 0,
      reason: 'DAILY_LIMIT',
    });
    expect(result.usageDate).toMatch(usageDatePattern);
    expect(getReserveCallCount()).toBe(1);
    expect(burstCounter.releaseReservation).toHaveBeenCalledWith('psid-1');
    expect(getCount()).toBe(15);
  });

  it('denies reserve on burst limit before daily transaction', async () => {
    const {
      service,
      getCount,
      getReserveCallCount,
      burstCounter,
      quotaEventRecorder,
    } = createService(true, 0, {
      burstCount: 3,
    });

    const result = await service.reserveFreeFormSlot('psid-1', {
      idempotencyKey: 'mid-burst',
    });

    expect(burstCounter.tryReserveBurst).toHaveBeenCalledWith('psid-1', 3);
    expect(quotaEventRecorder.recordDeniedBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        psid: 'psid-1',
        reason: 'BURST_LIMIT',
      }),
    );

    expect(result).toMatchObject({
      allowed: false,
      used: 3,
      limit: 3,
      remaining: 0,
      reason: 'BURST_LIMIT',
      quotaReserved: false,
    });
    expect(getReserveCallCount()).toBe(0);
    expect(getCount()).toBe(0);
  });

  it('reserves via tryReserveBurst', async () => {
    const { service, burstCounter } = createService(true, 0);

    await service.reserveFreeFormSlot('psid-1', {
      idempotencyKey: 'mid-ok',
    });

    expect(burstCounter.tryReserveBurst).toHaveBeenCalledWith('psid-1', 3);
  });

  it('passes transactional burst policy to the repository', async () => {
    const { service, repository } = createService(true, 0, {
      transactionalBurst: true,
      burstCountsRefunded: true,
    });

    await service.reserveFreeFormSlot('psid-1', {
      idempotencyKey: 'mid-db-burst',
    });

    expect(repository.reserveFreeFormSlotInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        burstLimit: 3,
        burstCountsRefunded: true,
      }),
    );
    const reserveInput = jest.mocked(
      repository.reserveFreeFormSlotInTransaction,
    ).mock.calls[0]?.[0];
    expect(reserveInput?.burstSince).toBeInstanceOf(Date);
  });

  it('does not add a DB burst check for non-transactional counters', async () => {
    const { service, repository } = createService(true);

    await service.reserveFreeFormSlot('psid-1', {
      idempotencyKey: 'mid-redis-burst',
    });

    const [input] = (repository.reserveFreeFormSlotInTransaction as jest.Mock)
      .mock.calls[0] as [Record<string, unknown>];
    expect(input.burstLimit).toBeUndefined();
    expect(input.burstSince).toBeUndefined();
    expect(input.burstCountsRefunded).toBeUndefined();
  });

  it('bypasses reserve for whitelisted psid', async () => {
    const { service, getCount, getReserveCallCount } = createService(true, 15, {
      whitelistPsids: 'psid-qa',
    });

    const result = await service.reserveFreeFormSlot('psid-qa', {
      idempotencyKey: 'mid-qa',
    });

    expect(result.allowed).toBe(true);
    expect(result.quotaReserved).toBe(false);
    expect(getReserveCallCount()).toBe(0);
    expect(getCount()).toBe(15);
  });

  it('rejects duplicate reserve for the same message mid', async () => {
    const { service, getCount } = createService(true, 0);

    const first = await service.reserveFreeFormSlot('psid-1', {
      idempotencyKey: 'mid-dup',
    });
    const second = await service.reserveFreeFormSlot('psid-1', {
      idempotencyKey: 'mid-dup',
    });

    expect(first.allowed).toBe(true);
    expect(first.used).toBe(1);
    expect(second).toMatchObject({
      allowed: false,
      limit: 15,
      reason: 'IDEMPOTENCY_CONFLICT',
    });
    expect(second.usageDate).toMatch(usageDatePattern);
    expect(getCount()).toBe(1);
  });

  it('refunds a reserved slot back to the previous count', async () => {
    const { service, getCount, burstCounter } = createService(true, 0);

    const reserved = await service.reserveFreeFormSlot('psid-1', {
      idempotencyKey: 'mid-refund',
    });
    expect(reserved.used).toBe(1);

    await service.refundFreeFormSlot(
      'psid-1',
      reserved.usageDate,
      'mid-refund',
    );

    expect(burstCounter.releaseReservation).toHaveBeenCalledWith('psid-1');
    expect(getCount()).toBe(0);
  });

  it('re-reserves after recovering stale reserved idempotency on conflict', async () => {
    const { service, repository } = createService(true, 0);
    const reserveMock = jest.mocked(
      repository.reserveFreeFormSlotInTransaction,
    );
    reserveMock
      .mockResolvedValueOnce({ status: 'idempotency_conflict' })
      .mockResolvedValueOnce({ status: 'reserved', freeFormCount: 1 });
    const recoverIdempotencyForRetryMock =
      repository.recoverIdempotencyForRetry as jest.Mock;
    recoverIdempotencyForRetryMock.mockResolvedValue('reopened');

    const result = await service.reserveFreeFormSlot('psid-1', {
      idempotencyKey: 'mid-stuck',
    });

    expect(recoverIdempotencyForRetryMock).toHaveBeenCalledWith(
      'mid-stuck',
      expect.any(Date),
    );
    expect(reserveMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      allowed: true,
      used: 1,
      quotaReserved: true,
    });
  });

  it('still denies duplicate reserve when idempotency is in flight', async () => {
    const { service, repository } = createService(true, 1);
    (
      repository.reserveFreeFormSlotInTransaction as jest.Mock
    ).mockResolvedValue({ status: 'idempotency_conflict' });
    (repository.recoverIdempotencyForRetry as jest.Mock).mockResolvedValue(
      'in_flight',
    );

    const result = await service.reserveFreeFormSlot('psid-1', {
      idempotencyKey: 'mid-flight',
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('recovers stuck reserved keys via ops helper', async () => {
    const { service, repository } = createService(true, 2);
    (repository.recoverAllStuckReserved as jest.Mock).mockResolvedValue([
      'mid-a',
      'mid-b',
    ]);

    await expect(service.recoverStuckReservedSlots()).resolves.toEqual({
      recovered: ['mid-a', 'mid-b'],
    });
  });

  it('denies reserve from transaction hard cap even if pre-check passed (H3)', async () => {
    const { service, repository } = createService(true, 14);
    (
      repository.reserveFreeFormSlotInTransaction as jest.Mock
    ).mockResolvedValue({ status: 'daily_limit_exceeded' });

    const result = await service.reserveFreeFormSlot('psid-1', {
      idempotencyKey: 'mid-cap',
    });

    expect(result).toMatchObject({
      allowed: false,
      used: 15,
      limit: 15,
      reason: 'DAILY_LIMIT',
      quotaReserved: false,
    });
  });

  describe('metrics — quotaDenied counter', () => {
    it('increments quotaDenied{reason=DAILY_LIMIT} when daily cap is reached', async () => {
      const { service, metrics } = createService(true, 15);

      await service.reserveFreeFormSlot('psid-1', { idempotencyKey: 'mid-1' });

      expect(metrics.incQuotaDenied).toHaveBeenCalledWith('DAILY_LIMIT');
    });

    it('increments quotaDenied{reason=BURST_LIMIT} when burst window is full', async () => {
      const { service, metrics } = createService(true, 0, { burstCount: 3 });

      await service.reserveFreeFormSlot('psid-1', { idempotencyKey: 'mid-2' });

      expect(metrics.incQuotaDenied).toHaveBeenCalledWith('BURST_LIMIT');
    });

    it('does not increment quotaDenied when reserve succeeds', async () => {
      const { service, metrics } = createService(true, 0);

      await service.reserveFreeFormSlot('psid-1', { idempotencyKey: 'mid-3' });

      expect(metrics.incQuotaDenied).not.toHaveBeenCalled();
    });

    it('increments quotaDenied{reason=DAILY_LIMIT} on H3 transaction hard cap', async () => {
      const { service, metrics, repository } = createService(true, 14);
      (
        repository.reserveFreeFormSlotInTransaction as jest.Mock
      ).mockResolvedValue({ status: 'daily_limit_exceeded' });

      await service.reserveFreeFormSlot('psid-1', { idempotencyKey: 'mid-4' });

      expect(metrics.incQuotaDenied).toHaveBeenCalledWith('DAILY_LIMIT');
    });
  });
});
