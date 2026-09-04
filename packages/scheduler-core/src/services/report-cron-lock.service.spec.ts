import type { QueryRunner } from 'typeorm';
import { ReportCronLockService } from './report-cron-lock.service';

describe('ReportCronLockService — per-platform advisory lock ids (#510)', () => {
  /**
   * Faithful in-memory PgAdvisoryLockService: a Set keyed by lock id, held
   * for the duration of acquire→release — two concurrent acquirers of the
   * same id are mutually exclusive, different ids never contend. This models
   * what the fix changes (id selection), not Postgres itself.
   */
  class MemoryLockService {
    readonly acquiredIds: number[] = [];
    private readonly held = new Set<number>();

    async acquire(lockId: number): Promise<QueryRunner | null> {
      this.acquiredIds.push(lockId);
      if (this.held.has(lockId)) return null;
      this.held.add(lockId);
      // A non-null runner means "acquired"; release() clears the id.
      return { id: lockId } as unknown as QueryRunner;
    }

    async release(lockId: number): Promise<void> {
      this.held.delete(lockId);
    }
  }

  function build(
    platform: 'messenger' | 'discord' | 'zalo',
    store = new MemoryLockService(),
  ) {
    return {
      service: new ReportCronLockService(store as never, platform),
      store,
    };
  }

  it('uses its platform-scoped lock id', async () => {
    const { service, store } = build('messenger');
    expect(await service.tryAcquireDailyLock()).toBe(true);
    // Messenger keeps the historical R4 id.
    expect(store.acquiredIds).toEqual([884_200_801]);
    await service.releaseDailyLock();
  });

  it('two platforms acquire their daily locks concurrently — neither skips', async () => {
    const store = new MemoryLockService();
    const messenger = build('messenger', store);
    const discord = build('discord', store);
    const zalo = build('zalo', store);

    await expect(messenger.service.tryAcquireDailyLock()).resolves.toBe(true);
    await expect(discord.service.tryAcquireDailyLock()).resolves.toBe(true);
    await expect(zalo.service.tryAcquireDailyLock()).resolves.toBe(true);

    await messenger.service.releaseDailyLock();
    await discord.service.releaseDailyLock();
    await zalo.service.releaseDailyLock();
  });

  it('two pods of the same platform still serialize on one id', async () => {
    const store = new MemoryLockService();
    const first = build('discord', store);
    const second = build('discord', store);

    await expect(first.service.tryAcquireDailyLock()).resolves.toBe(true);
    await expect(second.service.tryAcquireDailyLock()).resolves.toBe(false);
  });
});
