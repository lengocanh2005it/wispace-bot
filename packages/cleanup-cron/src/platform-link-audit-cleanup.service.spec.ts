import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { PlatformLinkAuditCleanupService } from './platform-link-audit-cleanup.service';

describe('PlatformLinkAuditCleanupService', () => {
  it('deletes bounded expired audit rows through the shared cleanup lock', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
      .mockResolvedValueOnce({ rowCount: 2 });
    const cleanupCron = {
      execute: jest.fn(async (_config, deleteFn) => deleteFn(new Date(0))),
    };
    const config = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;
    const service = new PlatformLinkAuditCleanupService(
      cleanupCron as never,
      config,
      { query } as unknown as DataSource,
      { platform: 'zalo', advisoryLockId: 884_200_942 },
    );

    await service.handleDailyCleanup();

    expect(cleanupCron.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'zalo-platform-link-audit-cleanup',
        advisoryLockId: 884_200_942,
      }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toEqual([new Date(0), 1000]);
    expect(query.mock.calls[1][1]).toEqual([[1, 2]]);
  });
});
