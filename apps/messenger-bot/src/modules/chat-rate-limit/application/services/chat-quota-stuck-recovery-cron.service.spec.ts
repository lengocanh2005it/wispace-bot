import { PgAdvisoryLockService } from '@wispace/bot-common';
import { ChatQuotaStuckRecoveryCronService } from './chat-quota-stuck-recovery-cron.service';

describe('ChatQuotaStuckRecoveryCronService', () => {
  const buildService = () => {
    const chatRateLimitService = {
      recoverStuckReservedSlots: jest
        .fn()
        .mockResolvedValue({ recovered: [] }),
    };
    const pgLock = {
      withLock: jest
        .fn()
        .mockImplementation((_id: number, fn: () => Promise<unknown>) => fn()),
    };
    const service = new ChatQuotaStuckRecoveryCronService(
      chatRateLimitService as never,
      pgLock as unknown as PgAdvisoryLockService,
    );
    return { service, chatRateLimitService, pgLock };
  };

  it('runs the recovery under the advisory lock', async () => {
    const { service, chatRateLimitService, pgLock } = buildService();

    await service.handleStuckRecovery();

    expect(pgLock.withLock).toHaveBeenCalledWith(
      884_200_906,
      expect.any(Function),
    );
    expect(chatRateLimitService.recoverStuckReservedSlots).toHaveBeenCalled();
  });

  it('skips the run when the lock is held by another pod', async () => {
    const { service, pgLock, chatRateLimitService } = buildService();
    pgLock.withLock.mockResolvedValue(null);

    await service.handleStuckRecovery();

    expect(chatRateLimitService.recoverStuckReservedSlots).not.toHaveBeenCalled();
  });
});
