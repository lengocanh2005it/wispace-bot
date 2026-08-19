import { PlatformDeadLetterService } from './platform-dead-letter.service';
import type { Repository } from 'typeorm';
import type { WebhookDeadLetterEntity } from '../entities/webhook-dead-letter.entity';
import type { Platform } from '../types';

describe('PlatformDeadLetterService', () => {
  const buildService = (platform: Platform) => {
    const saveMock = jest.fn().mockResolvedValue(undefined);
    const updateMock = jest.fn().mockResolvedValue(undefined);
    const createQueryBuilderMock = jest.fn();
    const repo = {
      save: saveMock,
      update: updateMock,
      createQueryBuilder: createQueryBuilderMock,
    } as unknown as Repository<WebhookDeadLetterEntity>;
    return {
      service: new PlatformDeadLetterService(platform, repo),
      saveMock,
      updateMock,
      createQueryBuilderMock,
    };
  };

  it('saves dead letter entry with pending status, platform and inbound direction', async () => {
    const { service, saveMock } = buildService('zalo');

    await service.save({
      externalUserId: 'u1',
      rawPayload: { event: 'test' },
      errorMessage: 'something failed',
    });

    expect(saveMock).toHaveBeenCalledWith({
      platform: 'zalo',
      externalUserId: 'u1',
      direction: 'inbound',
      rawPayload: { event: 'test' },
      errorMessage: 'something failed',
      status: 'pending',
    });
  });

  it('persists outbound direction when saving a send failure', async () => {
    const { service, saveMock } = buildService('discord');

    await service.save({
      externalUserId: 'u1234567890',
      rawPayload: { discordUserId: 'u1234567890', text: 'hi' },
      errorMessage: 'send failed for u1234567890',
      direction: 'outbound',
    });

    expect(saveMock).toHaveBeenCalledWith({
      platform: 'discord',
      externalUserId: 'u1234567890',
      direction: 'outbound',
      rawPayload: { discordUserId: 'u1234567890', text: 'hi' },
      errorMessage: 'send failed for u123…7890',
      status: 'pending',
    });
  });

  it('retries a transient persistence failure and reports success', async () => {
    const { service, saveMock } = buildService('discord');
    saveMock
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(undefined);

    const persisted = await service.save({
      externalUserId: 'u1',
      rawPayload: {},
      errorMessage: 'err',
    });

    expect(persisted).toBe(true);
    expect(saveMock).toHaveBeenCalledTimes(2);
  });

  it('returns false after bounded retries so callers treat the failure as unhandled', async () => {
    const { service, saveMock } = buildService('discord');
    saveMock.mockRejectedValue(new Error('db error'));

    const persisted = await service.save({
      externalUserId: 'u1',
      rawPayload: {},
      errorMessage: 'err',
    });

    expect(persisted).toBe(false);
    expect(saveMock).toHaveBeenCalledTimes(3);
  });

  it('marks entry as replayed', async () => {
    const { service, updateMock } = buildService('discord');

    await service.markReplayed(42);

    expect(updateMock).toHaveBeenCalledWith(42, {
      status: 'replayed',
      replayedAt: expect.any(Date),
      deliveryStatus: 'sent',
    });
  });

  it('claims a pending row for retry and persists a stable delivery key', async () => {
    const managerQuery = jest
      .fn()
      .mockResolvedValue([
        { id: 42, lease_token: 'lease-42', delivery_key: 'key-42' },
      ]);
    const repo = {
      manager: { query: managerQuery },
      update: jest.fn(),
      createQueryBuilder: jest.fn(),
    } as unknown as Repository<WebhookDeadLetterEntity>;
    const svc = new PlatformDeadLetterService('discord', repo);

    const claim = await svc.claimForRetry(42, 600_000);

    expect(claim).toEqual({
      id: 42,
      leaseToken: 'lease-42',
      deliveryKey: 'key-42',
    });
    const sql = managerQuery.mock.calls[0][0] as string;
    expect(sql).toContain('UPDATE "webhook_dead_letters"');
    expect(sql).toContain("status = 'processing'");
    expect(sql).toContain(
      'delivery_key = COALESCE(delivery_key, gen_random_uuid()::text)',
    );
    expect(sql).toContain('lease_token = gen_random_uuid()');
    expect(sql).toContain('RETURNING id, lease_token, delivery_key');
  });

  it('returns null when another worker already claimed the row', async () => {
    const repo = {
      manager: { query: jest.fn().mockResolvedValue([]) },
      update: jest.fn(),
      createQueryBuilder: jest.fn(),
    } as unknown as Repository<WebhookDeadLetterEntity>;
    const svc = new PlatformDeadLetterService('discord', repo);

    await expect(svc.claimForRetry(42, 600_000)).resolves.toBeNull();
  });

  it('markReplayed requires the current lease token and records the outcome', async () => {
    const mockExecute = jest.fn().mockResolvedValue({ affected: 1 });
    const chain = { execute: mockExecute } as Record<string, jest.Mock>;
    chain.andWhere = jest.fn().mockReturnValue(chain);
    const mockWhere = jest.fn().mockReturnValue({ andWhere: chain.andWhere });
    const mockSet = jest.fn().mockReturnValue({ where: mockWhere });
    const mockUpdate = jest.fn().mockReturnValue({ set: mockSet });
    const createQueryBuilderMock = jest
      .fn()
      .mockReturnValue({ update: mockUpdate });
    const repo = {
      manager: { query: jest.fn() },
      update: jest.fn(),
      createQueryBuilder: createQueryBuilderMock,
    } as unknown as Repository<WebhookDeadLetterEntity>;
    const svc = new PlatformDeadLetterService('discord', repo);

    const ok = await svc.markReplayed(42, 'lease-42', 'key-42');

    expect(ok).toBe(true);
    expect(mockSet).toHaveBeenCalledWith({
      status: 'replayed',
      replayedAt: expect.any(Date),
      deliveryStatus: 'sent',
      deliveryKey: 'key-42',
    });
    const whereCalls = mockWhere.mock.calls.concat(
      chain.andWhere.mock.calls as Array<[string, Record<string, unknown>?]>,
    );
    const whereSql = whereCalls.map(([sql]) => sql).join('\n');
    expect(whereSql).toContain('lease_token = :leaseToken');
    expect(whereSql).toContain('status = :status');
  });

  it('markReplayed no-ops for a stale owner (lease mismatch)', async () => {
    const mockExecute = jest.fn().mockResolvedValue({ affected: 0 });
    const chain = { execute: mockExecute } as Record<string, jest.Mock>;
    chain.andWhere = jest.fn().mockReturnValue(chain);
    const mockWhere = jest.fn().mockReturnValue({ andWhere: chain.andWhere });
    const mockSet = jest.fn().mockReturnValue({ where: mockWhere });
    const mockUpdate = jest.fn().mockReturnValue({ set: mockSet });
    const repo = {
      manager: { query: jest.fn() },
      update: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue({ update: mockUpdate }),
    } as unknown as Repository<WebhookDeadLetterEntity>;
    const svc = new PlatformDeadLetterService('discord', repo);

    const ok = await svc.markReplayed(42, 'stale-token', 'key-42');

    expect(ok).toBe(false);
  });

  it('markAbandoned with lease token records the delivery outcome for ambiguity', async () => {
    const mockExecute = jest.fn().mockResolvedValue({ affected: 1 });
    const chain = { execute: mockExecute } as Record<string, jest.Mock>;
    chain.andWhere = jest.fn().mockReturnValue(chain);
    const mockWhere = jest.fn().mockReturnValue({ andWhere: chain.andWhere });
    const mockSet = jest.fn().mockReturnValue({ where: mockWhere });
    const mockUpdate = jest.fn().mockReturnValue({ set: mockSet });
    const repo = {
      manager: { query: jest.fn() },
      update: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue({ update: mockUpdate }),
    } as unknown as Repository<WebhookDeadLetterEntity>;
    const svc = new PlatformDeadLetterService('discord', repo);

    const ok = await svc.markAbandoned(42, 'ambiguous delivery', 'u1', {
      leaseToken: 'lease-42',
      deliveryStatus: 'ambiguous',
    });

    expect(ok).toBe(true);
    expect(mockSet).toHaveBeenCalledWith({
      status: 'abandoned',
      errorMessage: 'ambiguous delivery',
      deliveryStatus: 'ambiguous',
    });
  });

  it('incrementRetry re-opens the row to pending and refreshes updated_at', async () => {
    const mockExecute = jest.fn().mockResolvedValue({ affected: 1 });
    const mockAndWhere = jest.fn().mockReturnValue({ execute: mockExecute });
    const mockWhere = jest.fn().mockReturnValue({ andWhere: mockAndWhere });
    const mockSet = jest.fn().mockReturnValue({ where: mockWhere });
    const mockUpdate = jest.fn().mockReturnValue({ set: mockSet });
    const createQueryBuilderMock = jest
      .fn()
      .mockReturnValue({ update: mockUpdate });
    const repo = {
      manager: { query: jest.fn() },
      update: jest.fn(),
      createQueryBuilder: createQueryBuilderMock,
    } as unknown as Repository<WebhookDeadLetterEntity>;
    const svc = new PlatformDeadLetterService('discord', repo);

    const ok = await svc.incrementRetry(42, 'timeout', 'u1', {
      leaseToken: 'lease-42',
    });

    expect(ok).toBe(true);
    const setCall = mockSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setCall.status).toBe('pending');
    expect(setCall.retryCount).toBeInstanceOf(Function);
    expect(setCall.leaseToken).toBeNull();
    expect(setCall.updatedAt).toBeInstanceOf(Date);
    const whereSql = mockWhere.mock.calls
      .concat(mockAndWhere.mock.calls)
      .map(([sql]) => sql)
      .join('\n');
    expect(whereSql).toContain('lease_token = :leaseToken');
  });

  it('marks entry as abandoned with reason', async () => {
    const { service, updateMock } = buildService('discord');

    await service.markAbandoned(42, 'max retries exceeded');

    expect(updateMock).toHaveBeenCalledWith(42, {
      status: 'abandoned',
      errorMessage: 'max retries exceeded',
    });
  });

  it('masks external ids in persisted abandoned reasons', async () => {
    const { service, updateMock } = buildService('discord');

    await service.markAbandoned(
      42,
      'failed for user-1234567890',
      'user-1234567890',
    );

    expect(updateMock).toHaveBeenCalledWith(42, {
      status: 'abandoned',
      errorMessage: 'failed for user…7890',
    });
  });

  it('increments retry count', async () => {
    const { service, createQueryBuilderMock } = buildService('discord');
    const mockExecute = jest.fn().mockResolvedValue(undefined);
    const mockWhere = jest.fn().mockReturnValue({ execute: mockExecute });
    const mockSet = jest.fn().mockReturnValue({ where: mockWhere });
    const mockUpdate = jest.fn().mockReturnValue({ set: mockSet });
    createQueryBuilderMock.mockReturnValue({
      update: mockUpdate,
    });

    await service.incrementRetry(42, 'timeout');

    expect(createQueryBuilderMock).toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalled();
    expect(mockWhere).toHaveBeenCalled();
    expect(mockExecute).toHaveBeenCalled();
  });
});
