import type { DataSource, EntityManager } from 'typeorm';
import {
  PrivacyCleanupJobStore,
  PRIVACY_CLEANUP_STORES,
} from './privacy-cleanup-job.service';

describe('PrivacyCleanupJobStore', () => {
  it('derives a stable opaque id from operation, platform, identity, and generation', () => {
    const base = {
      operation: 'unlink' as const,
      platform: 'messenger' as const,
      externalUserId: 'psid-1',
      mappingGeneration: '4',
    };

    expect(PrivacyCleanupJobStore.cleanupId(base)).toBe(
      PrivacyCleanupJobStore.cleanupId({ ...base }),
    );
    expect(PrivacyCleanupJobStore.cleanupId(base)).toHaveLength(32);
    expect(
      PrivacyCleanupJobStore.cleanupId({ ...base, mappingGeneration: '5' }),
    ).not.toBe(PrivacyCleanupJobStore.cleanupId(base));
  });

  it('keeps repeated enqueue calls in one process idempotent', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const manager = { query } as unknown as EntityManager;
    const store = new PrivacyCleanupJobStore({
      query,
    } as unknown as DataSource);
    const input = {
      operation: 'delete' as const,
      platform: 'discord' as const,
      externalUserId: 'discord-1',
      mappingGeneration: '2',
      stores: PRIVACY_CLEANUP_STORES.slice(0, 3),
    };

    const first = await store.enqueue(manager, input);
    const second = await store.enqueue(manager, input);

    expect(first.map(({ idempotencyKey }) => idempotencyKey)).toEqual(
      second.map(({ idempotencyKey }) => idempotencyKey),
    );
    expect(
      (await store.getByCleanupId(first[0].cleanupId, 'discord')).map(
        ({ store: stateStore }) => stateStore,
      ),
    ).toEqual(['chat_history', 'chat_queue', 'clarification_state']);
  });

  it('reclaims fallback due work with a lease and protects completion by lease token', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const store = new PrivacyCleanupJobStore({
      query,
    } as unknown as DataSource);
    const input = {
      operation: 'unlink' as const,
      platform: 'zalo' as const,
      externalUserId: 'zalo-1',
      mappingGeneration: '1',
      stores: ['chat_history'] as const,
    };
    const [ref] = await store.enqueue(
      { query } as unknown as EntityManager,
      input,
    );
    const [claimed] = await store.claimDue('zalo', 100, 60_000);

    expect(claimed.status).toBe('processing');
    expect(claimed.leaseToken).toEqual(expect.any(String));
    await store.markCompleted(claimed, claimed.leaseToken);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('AND lease_token = $2'),
      expect.arrayContaining([ref.idempotencyKey, claimed.leaseToken]),
    );
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('lease_token IS NULL'),
      expect.anything(),
    );
  });

  it('normalizes PostgreSQL UPDATE/DELETE RETURNING tuples', async () => {
    const claimedRow = {
      id: 7,
      cleanup_id: 'cleanup-7',
      idempotency_key: 'cleanup-7:chat_history',
      operation: 'unlink',
      platform: 'messenger',
      external_user_id: 'psid-7',
      user_id: 7,
      mapping_generation: '2',
      store: 'chat_history',
      status: 'processing',
      attempt_count: 0,
      next_retry_at: new Date(),
      lease_token: 'lease-7',
      lease_expires_at: new Date(Date.now() + 60_000),
      last_error: null,
    };
    const query = jest
      .fn()
      .mockResolvedValueOnce([[], 0])
      .mockResolvedValueOnce([[claimedRow], 1])
      .mockResolvedValueOnce([[{ id: 7 }, { id: 8 }], 2]);
    const store = new PrivacyCleanupJobStore({
      query,
    } as unknown as DataSource);

    await expect(store.claimDue('messenger')).resolves.toEqual([
      expect.objectContaining({
        id: '7',
        cleanupId: 'cleanup-7',
        store: 'chat_history',
      }),
    ]);
    await expect(store.pruneRetention()).resolves.toBe(2);
  });
});
