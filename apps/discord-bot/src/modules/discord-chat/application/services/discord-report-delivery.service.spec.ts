/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import type { DiscordReportAccountPageReaderPort } from '../../domain/ports/discord-report-account-reader.port';
import { DiscordReportDeliveryService } from './discord-report-delivery.service';
import {
  DiscordDeliveryFailureError,
  DiscordOutboundService,
} from './discord-outbound.service';

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
