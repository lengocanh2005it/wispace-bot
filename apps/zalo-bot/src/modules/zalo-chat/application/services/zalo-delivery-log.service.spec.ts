import { ZaloDeliveryLogService } from './zalo-delivery-log.service';
import type { Repository } from 'typeorm';
import type { ZaloMessageLogEntity } from '@zalo/infrastructure/database/entities/zalo-message-log.entity';

describe('ZaloDeliveryLogService', () => {
  const buildService = () => {
    const saveMock = jest.fn().mockResolvedValue(undefined);
    const repo = {
      save: saveMock,
    } as unknown as Repository<ZaloMessageLogEntity>;
    return { service: new ZaloDeliveryLogService(repo), saveMock };
  };

  it('saves delivery log with default message type', async () => {
    const { service, saveMock } = buildService();

    await service.logDelivery({
      externalUserId: 'u1',
      status: 'SENT',
    });

    expect(saveMock).toHaveBeenCalledWith({
      externalUserId: 'u1',
      status: 'SENT',
      error: null,
      messageType: 'chat',
    });
  });

  it('saves delivery log with custom message type and error', async () => {
    const { service, saveMock } = buildService();

    await service.logDelivery({
      externalUserId: 'u1',
      status: 'FAILED',
      error: 'timeout',
      messageType: 'report',
    });

    expect(saveMock).toHaveBeenCalledWith({
      externalUserId: 'u1',
      status: 'FAILED',
      error: 'timeout',
      messageType: 'report',
    });
  });

  it('swallows errors when save fails', async () => {
    const { service, saveMock } = buildService();
    saveMock.mockRejectedValue(new Error('db error'));

    await expect(
      service.logDelivery({ externalUserId: 'u1', status: 'SENT' }),
    ).resolves.toBeUndefined();
  });
});
