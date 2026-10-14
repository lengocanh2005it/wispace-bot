import type { DiscordReportAccountPageReaderPort } from '../../domain/ports/discord-report-account-reader.port';
import { DiscordReportDeliveryService } from './discord-report-delivery.service';
import {
  DiscordDeliveryFailureError,
  DiscordOutboundService,
  isAmbiguousDeliveryError,
  isDiscordRetryableError,
} from './discord-outbound.service';
import { DiscordSendTimeoutError } from '../../domain/discord-send-outcome.errors';

describe('DiscordReportDeliveryService', () => {
  function buildService() {
    const outbound = {
      sendText: jest.fn(),
    } as unknown as DiscordOutboundService;
    const accountLinkReader = {
      findLinkStateByExternalUserId: jest.fn().mockResolvedValue({
        id: '1',
        userId: 10,
        linkState: 'active',
      }),
    } as unknown as DiscordReportAccountPageReaderPort;

    return {
      service: new DiscordReportDeliveryService(outbound, accountLinkReader),
      outbound,
      accountLinkReader,
    };
  }

  it('returns RATE_LIMITED without treating the report as sent', async () => {
    const { service, outbound } = buildService();
    (outbound.sendText as jest.Mock).mockResolvedValue('rate_limited');

    await expect(
      service.sendReport({
        mapping: {
          id: 1,
          platform: 'discord',
          externalUserId: 'discord-1',
          userId: 10,
          status: 'ACTIVE',
        },
        reportText: 'report',
        reportDate: '2026-08-30',
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'RATE_LIMITED',
      outcome: 'rate_limited',
    });
  });

  it('maps a transient outbound failure to RETRYABLE for the report outbox', async () => {
    const { service, outbound } = buildService();
    (outbound.sendText as jest.Mock).mockRejectedValue(
      new DiscordDeliveryFailureError('delivery failed', false, true),
    );

    const result = await service.sendReport({
      mapping: {
        id: 1,
        platform: 'discord',
        externalUserId: 'discord-1',
        userId: 10,
        status: 'ACTIVE',
      },
      reportText: 'report',
      reportDate: '2026-08-30',
      deliveryKey: 'discord-report:discord-1:2026-08-30',
    });

    expect(result).toEqual({ ok: false, reason: 'RETRYABLE' });
    expect(outbound.sendText).toHaveBeenCalledWith(
      'discord-1',
      'report',
      expect.objectContaining({ skipDeadLetter: true, retryOn: 'none' }),
    );
  });

  it('marks an ambiguous outbound failure terminal instead of retrying', async () => {
    const { service, outbound } = buildService();
    (outbound.sendText as jest.Mock).mockRejectedValue(
      new DiscordDeliveryFailureError('delivery uncertain', true, true),
    );

    const result = await service.sendReport({
      mapping: {
        id: 1,
        platform: 'discord',
        externalUserId: 'discord-1',
        userId: 10,
        status: 'ACTIVE',
      },
      reportText: 'report',
      reportDate: '2026-08-30',
      deliveryKey: 'discord-report:discord-1:2026-08-30',
    });

    expect(result).toEqual({ ok: true, outcome: 'ambiguous' });
  });

  it('#1509: a stalled send reaches the outbox as ambiguous, never as a retryable failure', async () => {
    const { service, outbound } = buildService();
    // Built from the real predicates rather than hand-set flags, so this test
    // fails if either predicate is changed to make a no-verdict send
    // retryable — the case that would re-send a message Discord may hold.
    const timeout = new DiscordSendTimeoutError(15_000);
    expect(isDiscordRetryableError(timeout)).toBe(false);
    expect(isAmbiguousDeliveryError(timeout)).toBe(true);

    (outbound.sendText as jest.Mock).mockRejectedValue(
      new DiscordDeliveryFailureError(
        'Discord DM delivery failed',
        isAmbiguousDeliveryError(timeout),
        isDiscordRetryableError(timeout),
      ),
    );

    const result = await service.sendReport({
      mapping: {
        id: 1,
        platform: 'discord',
        externalUserId: 'discord-1',
        userId: 10,
        status: 'ACTIVE',
      },
      reportText: 'report',
      reportDate: '2026-08-30',
      deliveryKey: 'discord-report:discord-1:2026-08-30',
    });

    // `ambiguous` is recorded as sent: the outbox must not re-queue it.
    expect(result).toEqual({ ok: true, outcome: 'ambiguous' });
    expect(outbound.sendText).toHaveBeenCalledTimes(1);
  });

  it('re-checks the link state through the reader port before each chunk (#428)', async () => {
    const { service, outbound, accountLinkReader } = buildService();
    (outbound.sendText as jest.Mock).mockResolvedValue(undefined);

    await service.sendReport({
      mapping: {
        id: 1,
        platform: 'discord',
        externalUserId: 'discord-1',
        userId: 10,
        status: 'ACTIVE',
      },
      reportText: 'report',
      reportDate: '2026-08-30',
    });

    expect(
      accountLinkReader.findLinkStateByExternalUserId,
    ).toHaveBeenCalledWith('discord-1');
  });
});
