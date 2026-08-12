import { ConfigService } from '@nestjs/config';
import type { PlatformWebhookInboundEventService } from './platform-webhook-inbound-event.service';
import { PlatformWebhookInboundCleanupService } from './platform-webhook-inbound-cleanup.service';

describe('PlatformWebhookInboundCleanupService', () => {
  const buildService = (
    overrides: {
      configGet?: jest.Mock<unknown, [string]>;
      lockResult?: unknown;
    } = {},
  ) => {
    const deleteTerminalOlderThan = jest.fn().mockResolvedValue(5);
    const inboundEvents = {
      deleteTerminalOlderThan,
    } as unknown as PlatformWebhookInboundEventService;
    const configGet =
      overrides.configGet ?? jest.fn<unknown, [string]>(() => undefined);
    const configService = { get: configGet } as never as ConfigService;
    const withLock = jest
      .fn()
      .mockImplementation(async (_id: number, fn: () => Promise<unknown>) =>
        overrides.lockResult === null ? null : fn(),
      );
    const pgLock = { withLock };
    const service = new PlatformWebhookInboundCleanupService(
      inboundEvents,
      configService,
      pgLock as never,
      { lockId: 884_200_910 },
    );
    return { service, deleteTerminalOlderThan, configGet, withLock };
  };

  it('is enabled by default', () => {
    const { service } = buildService();
    expect(service.isEnabled()).toBe(true);
    expect(service.getRetentionDays()).toBe(30);
  });

  it('reads WEBHOOK_INBOUND_CLEANUP_ENABLED / WEBHOOK_INBOUND_RETENTION_DAYS', () => {
    const configGet = jest.fn<unknown, [string]>((key: string) => {
      if (key === 'WEBHOOK_INBOUND_CLEANUP_ENABLED') return 'false';
      if (key === 'WEBHOOK_INBOUND_RETENTION_DAYS') return '45';
      return undefined;
    });
    const { service } = buildService({ configGet });
    expect(service.isEnabled()).toBe(false);
    expect(service.getRetentionDays()).toBe(45);
  });

  it('deletes terminal rows older than the retention window under the advisory lock', async () => {
    const { service, deleteTerminalOlderThan, withLock } = buildService();

    await service.handleCleanup();

    expect(withLock).toHaveBeenCalledWith(884_200_910, expect.any(Function));
    expect(deleteTerminalOlderThan).toHaveBeenCalledWith(expect.any(Date));
  });

  it('skips the run when cleanup is disabled', async () => {
    const configGet = jest.fn<unknown, [string]>((key: string) =>
      key === 'WEBHOOK_INBOUND_CLEANUP_ENABLED' ? 'false' : undefined,
    );
    const { service, deleteTerminalOlderThan, withLock } = buildService({
      configGet,
    });

    await service.handleCleanup();

    expect(withLock).not.toHaveBeenCalled();
    expect(deleteTerminalOlderThan).not.toHaveBeenCalled();
  });

  it('does not delete anything when the advisory lock is held by another pod', async () => {
    const { service, deleteTerminalOlderThan } = buildService({
      lockResult: null,
    });

    await service.handleCleanup();

    expect(deleteTerminalOlderThan).not.toHaveBeenCalled();
  });
});
