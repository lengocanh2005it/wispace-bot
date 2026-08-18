import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { CleanupCronService } from '@wispace/cleanup-cron';
import { ChatIdempotencyEntity } from '@wispace/chat-metering';
import { ChatIdempotencyCleanupCronService } from './chat-idempotency-cleanup-cron.service';

describe('ChatIdempotencyCleanupCronService', () => {
  const buildService = () => {
    const configGet = jest.fn<unknown, [string]>(() => undefined);
    const configService = { get: configGet } as unknown as ConfigService;
    const deleteMock = jest
      .fn<Promise<{ affected: number }>, [Record<string, unknown>]>()
      .mockResolvedValue({ affected: 5 });
    const idempotencyRepo = {
      delete: deleteMock,
    } as unknown as Repository<ChatIdempotencyEntity>;
    const executeMock = jest
      .fn()
      .mockImplementation(
        (_config: unknown, fn: (cutoff: Date) => Promise<number>) =>
          fn(new Date()),
      );
    const cleanupCron = {
      execute: executeMock,
    } as unknown as CleanupCronService;

    const service = new ChatIdempotencyCleanupCronService(
      configService,
      idempotencyRepo,
      cleanupCron,
    );

    return { service, deleteMock, executeMock };
  };

  it('deletes terminal idempotency rows older than the cutoff', async () => {
    const { service, deleteMock, executeMock } = buildService();

    await service.handleDailyCleanup();

    const deleteArgs = deleteMock.mock.calls[0][0];
    expect((deleteArgs.status as { value?: string[] }).value).toEqual([
      'completed',
      'refunded',
    ]);
    expect(deleteArgs.reservedAt).toBeDefined();
    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({ advisoryLockId: 202 }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });
});
