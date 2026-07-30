import { ZaloReportDeliveryService } from './zalo-report-delivery.service';
import { ZaloOutboundService, ZaloSendError } from './zalo-outbound.service';

describe('ZaloReportDeliveryService', () => {
  it('sends report and returns true on success', async () => {
    const sendText = jest.fn().mockResolvedValue(undefined);
    const outbound = { sendText } as unknown as ZaloOutboundService;
    const service = new ZaloReportDeliveryService(outbound);

    const result = await service.sendReport('zalo-1', 'report text');

    expect(result).toBe(true);
    expect(sendText).toHaveBeenCalledWith('zalo-1', 'report text');
  });

  it('returns false on 48h window error', async () => {
    const sendText = jest
      .fn()
      .mockRejectedValue(new ZaloSendError('48h window closed', 403, true));
    const outbound = { sendText } as unknown as ZaloOutboundService;
    const service = new ZaloReportDeliveryService(outbound);

    const result = await service.sendReport('zalo-1', 'report text');

    expect(result).toBe(false);
  });

  it('returns false on other errors', async () => {
    const sendText = jest.fn().mockRejectedValue(new Error('network error'));
    const outbound = { sendText } as unknown as ZaloOutboundService;
    const service = new ZaloReportDeliveryService(outbound);

    const result = await service.sendReport('zalo-1', 'report text');

    expect(result).toBe(false);
  });
});
