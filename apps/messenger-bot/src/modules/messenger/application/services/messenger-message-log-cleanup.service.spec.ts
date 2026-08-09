import { MessengerMessageLogCleanupService } from './messenger-message-log-cleanup.service';
import type { MessengerMessageLogRepositoryPort } from '../../domain/repositories/messenger-message-log.repository.port';
import { CleanupCronService } from '@wispace/cleanup-cron';

describe('MessengerMessageLogCleanupService', () => {
  const deleteMessageLogsOlderThan = jest.fn<Promise<number>, [Date]>();

  const messengerRepository = {
    deleteMessageLogsOlderThan,
  } as unknown as MessengerMessageLogRepositoryPort;

  const cleanupCron = {
    execute: jest.fn(),
  } as unknown as CleanupCronService;

  const createService = (env: Record<string, string | undefined> = {}) => {
    const configService = {
      get: (key: string) => env[key],
    };

    return new MessengerMessageLogCleanupService(
      configService as never,
      messengerRepository,
      cleanupCron,
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('purges logs older than default retention', async () => {
    deleteMessageLogsOlderThan.mockResolvedValue(12);
    const service = createService();

    const result = await service.purgeExpiredLogs();

    expect(result.deleted).toBe(12);
    expect(service.getRetentionDays()).toBe(90);
    expect(deleteMessageLogsOlderThan).toHaveBeenCalledWith(expect.any(Date));
  });

  it('uses MESSENGER_MESSAGE_LOG_RETENTION_DAYS when set', async () => {
    deleteMessageLogsOlderThan.mockResolvedValue(0);
    const service = createService({
      MESSENGER_MESSAGE_LOG_RETENTION_DAYS: '30',
    });

    await service.purgeExpiredLogs();

    expect(service.getRetentionDays()).toBe(30);
    expect(deleteMessageLogsOlderThan).toHaveBeenCalledWith(expect.any(Date));
  });

  it('is enabled by default', () => {
    expect(createService().isEnabled()).toBe(true);
  });

  it('can be disabled via env', () => {
    expect(
      createService({
        MESSENGER_MESSAGE_LOG_CLEANUP_ENABLED: 'false',
      }).isEnabled(),
    ).toBe(false);
  });
});
