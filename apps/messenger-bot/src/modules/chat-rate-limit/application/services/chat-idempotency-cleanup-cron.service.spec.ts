import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { CleanupCronService } from '@wispace/cleanup-cron';
import {
  ChatIdempotencyEntity,
  ChatToolDailyUsageEntity,
} from '@wispace/chat-metering';
import { ChatIdempotencyCleanupCronService } from './chat-idempotency-cleanup-cron.service';

describe('ChatIdempotencyCleanupCronService', () => {
  const buildService = () => {
    const configGet = jest.fn<unknown, [string]>(() => undefined);
    const configService = { get: configGet } as unknown as ConfigService;
    const queryMock = jest
      .fn()
      .mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const deleteExecuteMock = jest.fn().mockResolvedValue({ affected: 3 });
    const deleteWhereMock = jest.fn(() => ({
      execute: deleteExecuteMock,
    }));
    const idempotencyRepo = {
      query: queryMock,
      createQueryBuilder: jest.fn(() => ({
        delete: () => ({
          from: () => ({ where: deleteWhereMock }),
        }),
      })),
    } as unknown as Repository<ChatIdempotencyEntity>;
    const toolQueryMock = jest.fn().mockResolvedValue([]);
    const toolDailyUsageRepo = {
      manager: { query: toolQueryMock },
    } as unknown as Repository<ChatToolDailyUsageEntity>;
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
      toolDailyUsageRepo,
      cleanupCron,
    );

    return { service, queryMock, toolQueryMock, deleteWhereMock, executeMock };
  };

  it('deletes terminal idempotency rows older than the cutoff using bounded batch', async () => {
    const { service, queryMock, deleteWhereMock, executeMock } = buildService();

    await service.handleDailyCleanup();

    // Verify the SELECT query uses bounded batch
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('SELECT id FROM chat_idempotency'),
      expect.arrayContaining([expect.any(Date), 1000]),
    );
    // Verify the DELETE uses the returned IDs
    expect(deleteWhereMock).toHaveBeenCalledWith('id IN (:...ids)', {
      ids: [1, 2, 3],
    });
    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({ advisoryLockId: 202 }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });
  it('prunes aged chat_tool_daily_usage rows (#626)', async () => {
    const { service, toolQueryMock } = buildService();
    await service.handleDailyCleanup();
    expect(toolQueryMock).toHaveBeenCalledWith(
      expect.stringContaining(
        'DELETE FROM chat_tool_daily_usage WHERE platform = \x27messenger\x27 AND usage_date <',
      ),
      expect.any(Array),
    );
  });
});
