import { PlatformDeadLetterService } from './platform-dead-letter.service';
import type { Repository } from 'typeorm';
import type { WebhookDeadLetterEntity } from '../entities/webhook-dead-letter.entity';

describe('PlatformDeadLetterService', () => {
  const buildService = (platform: string) => {
    const saveMock = jest.fn().mockResolvedValue(undefined);
    const updateMock = jest.fn().mockResolvedValue(undefined);
    const createQueryBuilderMock = jest.fn();
    const repo = {
      save: saveMock,
      update: updateMock,
      createQueryBuilder: createQueryBuilderMock,
    } as unknown as Repository<WebhookDeadLetterEntity>;
    return {
      service: new PlatformDeadLetterService(platform, repo),
      saveMock,
      updateMock,
      createQueryBuilderMock,
    };
  };

  it('saves dead letter entry with pending status and platform', async () => {
    const { service, saveMock } = buildService('zalo');

    await service.save({
      externalUserId: 'u1',
      rawPayload: { event: 'test' },
      errorMessage: 'something failed',
    });

    expect(saveMock).toHaveBeenCalledWith({
      platform: 'zalo',
      externalUserId: 'u1',
      rawPayload: { event: 'test' },
      errorMessage: 'something failed',
      status: 'pending',
    });
  });

  it('swallows errors when save fails', async () => {
    const { service, saveMock } = buildService('discord');
    saveMock.mockRejectedValue(new Error('db error'));

    await expect(
      service.save({
        externalUserId: 'u1',
        rawPayload: {},
        errorMessage: 'err',
      }),
    ).resolves.toBeUndefined();
  });

  it('marks entry as replayed', async () => {
    const { service, updateMock } = buildService('discord');

    await service.markReplayed(42);

    expect(updateMock).toHaveBeenCalledWith(42, {
      status: 'replayed',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      replayedAt: expect.any(Date),
    });
  });

  it('marks entry as abandoned with reason', async () => {
    const { service, updateMock } = buildService('discord');

    await service.markAbandoned(42, 'max retries exceeded');

    expect(updateMock).toHaveBeenCalledWith(42, {
      status: 'abandoned',
      errorMessage: 'max retries exceeded',
    });
  });

  it('increments retry count', async () => {
    const { service, createQueryBuilderMock } = buildService('discord');
    const mockExecute = jest.fn().mockResolvedValue(undefined);
    const mockWhere = jest.fn().mockReturnValue({ execute: mockExecute });
    const mockSet = jest.fn().mockReturnValue({ where: mockWhere });
    const mockUpdate = jest.fn().mockReturnValue({ set: mockSet });
    createQueryBuilderMock.mockReturnValue({
      update: mockUpdate,
    });

    await service.incrementRetry(42, 'timeout');

    expect(createQueryBuilderMock).toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalled();
    expect(mockWhere).toHaveBeenCalled();
    expect(mockExecute).toHaveBeenCalled();
  });
});
