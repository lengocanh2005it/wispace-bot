/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import type { Repository } from 'typeorm';
import type { DiscordAccountLinkEntity } from '@discord/infrastructure/database/entities/discord-account-link.entity';
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
    const accountLinkRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 1,
        platform: 'discord',
        externalUserId: 'discord-1',
        userId: 10,
        linkState: 'active',
      }),
    } as unknown as Repository<DiscordAccountLinkEntity>;

    return {
      service: new DiscordReportDeliveryService(outbound, accountLinkRepo),
      outbound,
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
});
