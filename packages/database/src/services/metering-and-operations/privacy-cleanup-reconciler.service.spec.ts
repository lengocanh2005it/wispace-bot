import type { DataSource } from 'typeorm';
import { PrivacyCleanupReconciler } from './privacy-cleanup-reconciler.service';
import type {
  PrivacyCleanupJobRow,
  PrivacyCleanupJobStore,
} from './privacy-cleanup-job.service';

function job(
  overrides: Partial<PrivacyCleanupJobRow> = {},
): PrivacyCleanupJobRow {
  return {
    id: '1',
    cleanupId: 'cleanup-1',
    idempotencyKey: 'cleanup-1:chat_history',
    operation: 'unlink',
    platform: 'discord',
    externalUserId: 'discord-1',
    mappingGeneration: '7',
    store: 'chat_history',
    status: 'processing',
    attemptCount: 0,
    leaseToken: 'lease-1',
    ...overrides,
  };
}

describe('PrivacyCleanupReconciler', () => {
  it('retries due own-platform work and marks only the successful job complete', async () => {
    const clearHistory = jest.fn().mockResolvedValue(undefined);
    const store = {
      claimDue: jest.fn().mockResolvedValue([job()]),
      markCompleted: jest.fn().mockResolvedValue(undefined),
      markFailure: jest.fn().mockResolvedValue(undefined),
      markStale: jest.fn().mockResolvedValue(undefined),
      pruneRetention: jest.fn().mockResolvedValue(0),
      getSummary: jest.fn().mockResolvedValue({
        pendingCount: 0,
        processingCount: 0,
        retryingCount: 0,
        oldestPendingAgeSeconds: null,
      }),
    } as unknown as PrivacyCleanupJobStore;
    const reconciler = new PrivacyCleanupReconciler(
      { query: jest.fn().mockResolvedValue([]) } as unknown as DataSource,
      'discord',
      {
        platform: 'discord',
        applicableStores: ['chat_history'],
        clearHistory,
      },
      { store },
    );

    await expect(reconciler.runOnce()).resolves.toMatchObject({
      claimed: 1,
      completed: 1,
      failed: 0,
      stale: 0,
    });
    expect(clearHistory).toHaveBeenCalledWith('discord-1');
    expect(store.markCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'cleanup-1:chat_history' }),
      'lease-1',
    );
  });

  it('retires a job when an active mapping is present instead of touching its state', async () => {
    const clearHistory = jest.fn().mockResolvedValue(undefined);
    const store = {
      claimDue: jest.fn().mockResolvedValue([job()]),
      markCompleted: jest.fn().mockResolvedValue(undefined),
      markFailure: jest.fn().mockResolvedValue(undefined),
      markStale: jest.fn().mockResolvedValue(undefined),
      pruneRetention: jest.fn().mockResolvedValue(0),
      getSummary: jest.fn().mockResolvedValue({
        pendingCount: 0,
        processingCount: 0,
        retryingCount: 0,
        oldestPendingAgeSeconds: null,
      }),
    } as unknown as PrivacyCleanupJobStore;
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        { mapping_generation: '8', link_state: 'active' },
      ])
      .mockResolvedValue([]);
    const reconciler = new PrivacyCleanupReconciler(
      { query } as unknown as DataSource,
      'discord',
      {
        platform: 'discord',
        applicableStores: ['chat_history'],
        clearHistory,
      },
      { store },
    );

    await expect(reconciler.runOnce()).resolves.toMatchObject({ stale: 1 });
    expect(clearHistory).not.toHaveBeenCalled();
    expect(store.markStale).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'cleanup-1:chat_history' }),
      'lease-1',
    );
  });
});
