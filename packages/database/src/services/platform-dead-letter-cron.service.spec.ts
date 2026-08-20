import { ConfigService } from '@nestjs/config';
import type { WebhookDeadLetterEntry } from '../entities/webhook-dead-letter.entity';
import type { DeadLetterClaim } from './platform-dead-letter.service';
import {
  PlatformDeadLetterCronService,
  type DeadLetterCronOptions,
} from './platform-dead-letter-cron.service';

function buildOptions(
  overrides: Partial<DeadLetterCronOptions> = {},
): DeadLetterCronOptions {
  return {
    lockId: 884_200_930,
    extractPayload: (payload) => ({
      externalUserId: payload.discordUserId as string | undefined,
      text: payload.text as string | undefined,
    }),
    abandonReason: 'Missing discordUserId or text in payload',
    sendText: jest.fn().mockResolvedValue('sent'),
    ...overrides,
  };
}

function buildService(options: DeadLetterCronOptions): {
  service: PlatformDeadLetterCronService;
  deadLetterService: {
    listPendingForRetry: jest.Mock<
      Promise<WebhookDeadLetterEntry[]>,
      [{ limit: number; olderThan: Date; maxRetries: number }]
    >;
    claimForRetry: jest.Mock<Promise<DeadLetterClaim | null>, [number, number]>;
    markAbandoned: jest.Mock;
    markReplayed: jest.Mock;
    incrementRetry: jest.Mock;
  };
  configGet: jest.Mock<unknown, [string]>;
  pgLock: { withLock: jest.Mock };
} {
  const deadLetterService = {
    listPendingForRetry: jest
      .fn<
        Promise<WebhookDeadLetterEntry[]>,
        [{ limit: number; olderThan: Date; maxRetries: number }]
      >()
      .mockResolvedValue([]),
    claimForRetry: jest
      .fn<Promise<DeadLetterClaim | null>, [number, number]>()
      .mockImplementation((id: number) =>
        Promise.resolve({
          id,
          leaseToken: `lease-${id}`,
          deliveryKey: `key-${id}`,
        }),
      ),
    markAbandoned: jest.fn().mockResolvedValue(true),
    markReplayed: jest.fn().mockResolvedValue(true),
    incrementRetry: jest.fn().mockResolvedValue(true),
  };
  const configGet = jest.fn<unknown, [string]>(() => undefined);
  const configService = { get: configGet } as never as ConfigService;
  const pgLock = {
    withLock: jest
      .fn()
      .mockImplementation((_id: number, fn: () => Promise<void>) => fn()),
  };
  const service = new PlatformDeadLetterCronService(
    deadLetterService as never,
    configService,
    pgLock as never,
    options,
  );
  return { service, deadLetterService, configGet, pgLock };
}

function entry(
  overrides: Partial<WebhookDeadLetterEntry> = {},
): WebhookDeadLetterEntry {
  return {
    id: 1,
    externalUserId: 'user-1',
    rawPayload: { discordUserId: 'user-1', text: 'hello' },
    errorMessage: 'err',
    retryCount: 0,
    status: 'pending',
    ...overrides,
  };
}

describe('PlatformDeadLetterCronService', () => {
  it('abandons entries whose payload has no extractable target', async () => {
    const options = buildOptions({
      extractPayload: () => ({ externalUserId: undefined, text: undefined }),
    });
    const { service, deadLetterService } = buildService(options);
    deadLetterService.listPendingForRetry.mockResolvedValue([entry()]);

    await service.handleRetry();

    expect(deadLetterService.markAbandoned).toHaveBeenCalledWith(
      1,
      'Missing discordUserId or text in payload',
      'user-1',
      { leaseToken: 'lease-1' },
    );
    expect(options.sendText).not.toHaveBeenCalled();
  });

  it('claims the row, reuses the persisted delivery key, and marks it replayed', async () => {
    const options = buildOptions();
    const { service, deadLetterService } = buildService(options);
    deadLetterService.listPendingForRetry.mockResolvedValue([entry()]);

    await service.handleRetry();

    expect(deadLetterService.claimForRetry).toHaveBeenCalledWith(
      1,
      expect.any(Number),
    );
    expect(options.sendText).toHaveBeenCalledWith('user-1', 'hello', {
      deliveryKey: 'key-1',
    });
    expect(deadLetterService.markReplayed).toHaveBeenCalledWith(
      1,
      'lease-1',
      'key-1',
    );
  });

  it('skips rows claimed by another worker (concurrent replay guard)', async () => {
    const options = buildOptions();
    const { service, deadLetterService } = buildService(options);
    deadLetterService.listPendingForRetry.mockResolvedValue([entry()]);
    deadLetterService.claimForRetry.mockResolvedValue(null);

    await service.handleRetry();

    expect(options.sendText).not.toHaveBeenCalled();
    expect(deadLetterService.markReplayed).not.toHaveBeenCalled();
    expect(deadLetterService.incrementRetry).not.toHaveBeenCalled();
    expect(deadLetterService.markAbandoned).not.toHaveBeenCalled();
  });

  it('increments retry below maxRetries and abandons at maxRetries on not_sent', async () => {
    const options = buildOptions({
      sendText: jest.fn().mockResolvedValue('not_sent'),
    });
    const { service, deadLetterService } = buildService(options);
    deadLetterService.listPendingForRetry.mockResolvedValue([
      entry({ retryCount: 0 }),
      entry({ id: 2, retryCount: 3 }),
    ]);

    await service.handleRetry();

    expect(deadLetterService.incrementRetry).toHaveBeenCalledWith(
      1,
      'send failed',
      'user-1',
      { leaseToken: 'lease-1' },
    );
    expect(deadLetterService.markAbandoned).toHaveBeenCalledWith(
      2,
      'send failed',
      'user-1',
      { leaseToken: 'lease-2' },
    );
  });

  it('treats a thrown send error as not_sent (retry/abandon path)', async () => {
    const options = buildOptions({
      sendText: jest.fn().mockRejectedValue(new Error('send failed')),
    });
    const { service, deadLetterService } = buildService(options);
    deadLetterService.listPendingForRetry.mockResolvedValue([entry()]);

    await service.handleRetry();

    expect(deadLetterService.incrementRetry).toHaveBeenCalledWith(
      1,
      'send failed',
      'user-1',
      { leaseToken: 'lease-1' },
    );
  });

  it('marks ambiguous delivery terminal (no auto-resend) when retryAmbiguous is false', async () => {
    const options = buildOptions({
      sendText: jest.fn().mockResolvedValue('ambiguous'),
    });
    const { service, deadLetterService } = buildService(options);
    deadLetterService.listPendingForRetry.mockResolvedValue([entry()]);

    await service.handleRetry();

    expect(deadLetterService.markAbandoned).toHaveBeenCalledWith(
      1,
      'ambiguous delivery — not auto-retried',
      'user-1',
      { leaseToken: 'lease-1', deliveryStatus: 'ambiguous' },
    );
    expect(deadLetterService.incrementRetry).not.toHaveBeenCalled();
    expect(deadLetterService.markReplayed).not.toHaveBeenCalled();
  });

  it('retries ambiguous delivery with the same delivery key when retryAmbiguous is true', async () => {
    const options = buildOptions({
      retryAmbiguous: true,
      sendText: jest.fn().mockResolvedValue('ambiguous'),
    });
    const { service, deadLetterService } = buildService(options);
    deadLetterService.listPendingForRetry.mockResolvedValue([entry()]);

    await service.handleRetry();

    expect(options.sendText).toHaveBeenCalledWith('user-1', 'hello', {
      deliveryKey: 'key-1',
    });
    expect(deadLetterService.incrementRetry).toHaveBeenCalledWith(
      1,
      'ambiguous delivery — retried with the same delivery key',
      'user-1',
      { leaseToken: 'lease-1' },
    );
    expect(deadLetterService.markAbandoned).not.toHaveBeenCalled();
  });

  it('reads retry settings from config', async () => {
    const options = buildOptions();
    const { service, deadLetterService, configGet } = buildService(options);
    configGet.mockImplementation((key: string) => {
      if (key === 'WEBHOOK_DEAD_LETTER_MAX_RETRIES') return 5;
      if (key === 'WEBHOOK_DEAD_LETTER_MIN_RETRY_AGE_MS') return 120_000;
      if (key === 'WEBHOOK_DEAD_LETTER_RETRY_LIMIT') return 3;
      if (key === 'WEBHOOK_DEAD_LETTER_LEASE_MS') return 900_000;
      return undefined;
    });
    deadLetterService.listPendingForRetry.mockResolvedValue([entry()]);

    await service.handleRetry();

    const { limit, olderThan, maxRetries } =
      deadLetterService.listPendingForRetry.mock.calls[0][0];
    expect(limit).toBe(3);
    expect(maxRetries).toBe(5);
    expect(Math.abs(olderThan.getTime() - (Date.now() - 120_000))).toBeLessThan(
      1000,
    );
    expect(deadLetterService.claimForRetry).toHaveBeenCalledWith(
      expect.any(Number),
      900_000,
    );
  });

  it('runs the retry batch under the advisory lock', async () => {
    const options = buildOptions();
    const { service, pgLock, deadLetterService } = buildService(options);

    await service.handleRetry();

    expect(pgLock.withLock).toHaveBeenCalledWith(
      884_200_930,
      expect.any(Function),
    );
    expect(deadLetterService.listPendingForRetry).toHaveBeenCalled();
  });

  it('skips the batch when the advisory lock is held by another pod', async () => {
    const options = buildOptions();
    const { service, pgLock, deadLetterService } = buildService(options);
    pgLock.withLock.mockResolvedValue(null);

    await service.handleRetry();

    expect(deadLetterService.listPendingForRetry).not.toHaveBeenCalled();
  });

  it('falls back to defaults on malformed env values', async () => {
    const options = buildOptions();
    const { service, deadLetterService, configGet } = buildService(options);
    configGet.mockImplementation((key: string) => {
      if (key === 'WEBHOOK_DEAD_LETTER_MAX_RETRIES') return 'not-a-number';
      if (key === 'WEBHOOK_DEAD_LETTER_MIN_RETRY_AGE_MS') return '60k';
      if (key === 'WEBHOOK_DEAD_LETTER_RETRY_LIMIT') return -1;
      return undefined;
    });
    deadLetterService.listPendingForRetry.mockResolvedValue([entry()]);

    await service.handleRetry();

    const { limit, maxRetries, olderThan } =
      deadLetterService.listPendingForRetry.mock.calls[0][0];
    expect(maxRetries).toBe(3);
    expect(limit).toBe(10);
    expect(Number.isNaN(olderThan.getTime())).toBe(false);
  });
});
