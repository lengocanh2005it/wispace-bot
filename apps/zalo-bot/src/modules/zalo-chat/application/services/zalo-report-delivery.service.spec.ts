/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import { ZaloReportDeliveryService } from './zalo-report-delivery.service';
import { ZaloOutboundService, ZaloSendError } from './zalo-outbound.service';
import { ZaloAccountLinkService } from '@zalo/modules/zalo-oauth/application/services/zalo-account-link.service';

describe('ZaloReportDeliveryService', () => {
  function buildService() {
    const outbound = {
      sendText: jest.fn(),
      sendTextForRetry: jest.fn(),
    } as unknown as ZaloOutboundService;
    const accountLinkService = {
      findCurrentIdentity: jest.fn().mockResolvedValue({
        userId: 10,
        externalUserId: 'zalo-1',
      }),
    } as unknown as ZaloAccountLinkService;

    return {
      service: new ZaloReportDeliveryService(outbound, accountLinkService),
      outbound,
    };
  }

  it('maps a transient outbound failure to RETRYABLE for the report outbox', async () => {
    const { service, outbound } = buildService();
    (outbound.sendText as jest.Mock).mockRejectedValue(
      new ZaloSendError(
        'temporary outage',
        503,
        'Service Unavailable',
        'outage',
      ),
    );

    const result = await service.sendReport({
      mapping: {
        externalUserId: 'zalo-1',
        userId: 10,
      },
      reportText: 'report',
      reportDate: '2026-08-30',
      deliveryKey: 'zalo-report:zalo-1:2026-08-30',
    });

    expect(result).toEqual({ ok: false, reason: 'RETRYABLE' });
    expect(outbound.sendText).toHaveBeenCalledWith(
      'zalo-1',
      'report',
      expect.objectContaining({ deadLetterOn: 'ambiguous' }),
    );
    expect(outbound.sendTextForRetry).not.toHaveBeenCalled();
  });
});
