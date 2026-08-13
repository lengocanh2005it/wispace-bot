/* eslint-disable @typescript-eslint/no-unsafe-return -- fluent Jest query-builder fake */
import { PlatformWebhookInboundEventService } from './platform-webhook-inbound-event.service';
import type { Repository } from 'typeorm';
import type { WebhookInboundEventEntity } from '../entities/webhook-inbound-event.entity';

describe('PlatformWebhookInboundEventService', () => {
  const buildService = () => {
    const executeMock = jest.fn().mockResolvedValue({ raw: [{ id: 1 }] });
    const insertMock = jest.fn(() => ({
      into: jest.fn(() => ({
        values: jest.fn(() => ({
          orIgnore: jest.fn(() => ({
            returning: jest.fn(() => ({ execute: executeMock })),
          })),
        })),
      })),
    }));
    const getManyMock = jest.fn().mockResolvedValue([]);
    const limitMock = jest.fn(() => ({ getMany: getManyMock }));
    const orderByMock = jest.fn(() => ({ limit: limitMock }));
    const andWhere1Mock = jest.fn(() => ({ orderBy: orderByMock }));
    const whereMock = jest.fn(() => ({ andWhere: andWhere1Mock }));
    const claimExecuteMock = jest.fn().mockResolvedValue({ affected: 1 });
    const claimAndWhereMock = jest.fn(() => ({ execute: claimExecuteMock }));
    const claimWhereMock = jest.fn(() => ({ andWhere: claimAndWhereMock }));
    const claimSetMock = jest.fn(() => ({ where: claimWhereMock }));
    const claimUpdateMock = jest.fn(() => ({ set: claimSetMock }));
    const createQueryBuilderMock = jest.fn(() => ({
      insert: insertMock,
      where: whereMock,
      update: claimUpdateMock,
    }));
    const findOneMock = jest.fn().mockResolvedValue({ id: 1, retryCount: 0 });
    const updateMock = jest
      .fn<Promise<void>, [number, Record<string, unknown>]>()
      .mockResolvedValue(undefined);
    const repo = {
      createQueryBuilder: createQueryBuilderMock,
      findOne: findOneMock,
      update: updateMock,
    } as unknown as Repository<WebhookInboundEventEntity>;

    return {
      service: new PlatformWebhookInboundEventService('messenger', repo),
      executeMock,
      getManyMock,
      whereMock,
      findOneMock,
      updateMock,
      claimExecuteMock,
      claimWhereMock,
      claimAndWhereMock,
    };
  };

  describe('ingest', () => {
    it('returns the inserted row id for a first delivery', async () => {
      const { service, executeMock } = buildService();
      executeMock.mockResolvedValue({ raw: [{ id: 7 }] });

      const result = await service.ingest({
        eventId: 'mid-1',
        externalUserId: 'psid-1',
        eventType: 'message',
        rawPayload: { message: { mid: 'mid-1' } },
      });

      expect(result).toEqual({ inserted: true, id: 7 });
    });

    it('returns inserted=false for a duplicate delivery (idempotent)', async () => {
      const { service, executeMock } = buildService();
      executeMock.mockResolvedValue({ raw: [] });

      const result = await service.ingest({
        eventId: 'mid-1',
        rawPayload: { message: { mid: 'mid-1' } },
      });

      expect(result).toEqual({ inserted: false });
    });
  });

  describe('claim', () => {
    it('claims a pending/failed event (pending/failed → processing)', async () => {
      const { service, claimExecuteMock, claimWhereMock, claimAndWhereMock } =
        buildService();
      claimExecuteMock.mockResolvedValue({ affected: 1 });

      const claimed = await service.claim(7);

      expect(claimed).toBe(true);
      expect(claimWhereMock).toHaveBeenCalledWith('id = :id', { id: 7 });
      expect(claimAndWhereMock).toHaveBeenCalledWith(
        'status IN (:...statuses)',
        { statuses: ['pending', 'failed'] },
      );
    });

    it('returns false when another worker already claimed the event', async () => {
      const { service, claimExecuteMock } = buildService();
      claimExecuteMock.mockResolvedValue({ affected: 0 });

      const claimed = await service.claim(7);

      expect(claimed).toBe(false);
    });
  });

  describe('markCompleted', () => {
    it('marks the event completed and clears retry state', async () => {
      const { service, updateMock } = buildService();

      await service.markCompleted(42);

      expect(updateMock).toHaveBeenCalledWith(
        42,
        expect.objectContaining({
          status: 'completed',
          lastError: null,
          nextRetryAt: null,
        }),
      );
      const patch = updateMock.mock.calls[0][1];
      expect(patch['processedAt']).toBeInstanceOf(Date);
    });
  });

  describe('markFailed', () => {
    it('schedules a bounded backoff retry', async () => {
      const { service, updateMock, findOneMock } = buildService();
      findOneMock.mockResolvedValue({
        id: 1,
        retryCount: 0,
        externalUserId: 'psid-1234567890',
      });
      const now = Date.now();

      await service.markFailed(1, 'failed for psid-1234567890', {
        maxRetries: 5,
        baseRetryMs: 60_000,
        capRetryMs: 8 * 60_000,
      });

      expect(updateMock).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          status: 'failed',
          retryCount: 1,
          lastError: 'failed for psid…7890',
        }),
      );
      const patch = updateMock.mock.calls[0][1];
      expect(patch['processedAt']).toBeInstanceOf(Date);
      expect((patch['nextRetryAt'] as Date).getTime()).toBeGreaterThanOrEqual(
        now + 60_000,
      );
    });

    it('caps the backoff at the cap', async () => {
      const { service, updateMock, findOneMock } = buildService();
      findOneMock.mockResolvedValue({ id: 1, retryCount: 10 });

      await service.markFailed(1, 'boom', {
        maxRetries: 15,
        baseRetryMs: 60_000,
        capRetryMs: 8 * 60_000,
      });

      const patch = updateMock.mock.calls[0][1];
      expect((patch['nextRetryAt'] as Date).getTime()).toBeLessThanOrEqual(
        Date.now() + 8 * 60_000,
      );
    });

    it('marks the event abandoned (terminal) when the budget is exhausted', async () => {
      const { service, updateMock, findOneMock } = buildService();
      findOneMock.mockResolvedValue({ id: 1, retryCount: 4 });

      await service.markFailed(1, 'still broken', {
        maxRetries: 5,
        baseRetryMs: 60_000,
        capRetryMs: 8 * 60_000,
      });

      expect(updateMock).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          status: 'abandoned',
          retryCount: 5,
          nextRetryAt: null,
        }),
      );
    });
  });

  describe('listDue', () => {
    it('queries pending/failed events whose backoff has elapsed for the platform', async () => {
      const { service, getManyMock, whereMock } = buildService();
      getManyMock.mockResolvedValue([
        {
          id: 1,
          platform: 'messenger',
          eventId: 'mid-1',
          externalUserId: 'psid-1',
          eventType: 'message',
          rawPayload: { message: { mid: 'mid-1' } },
          status: 'failed',
          retryCount: 1,
          nextRetryAt: new Date(),
        },
      ]);

      const rows = await service.listDue({ limit: 20 });

      expect(whereMock).toHaveBeenCalledWith('evt.platform = :platform', {
        platform: 'messenger',
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ eventId: 'mid-1', status: 'failed' });
    });

    it('includes stale processing rows (crash between claim and mark)', async () => {
      const { service, getManyMock } = buildService();
      getManyMock.mockResolvedValue([
        {
          id: 2,
          platform: 'messenger',
          eventId: 'mid-2',
          externalUserId: 'psid-1',
          eventType: 'message',
          rawPayload: { message: { mid: 'mid-2' } },
          status: 'processing',
          retryCount: 0,
          nextRetryAt: null,
        },
      ]);

      const rows = await service.listDue({
        limit: 20,
        processingStuckMs: 300_000,
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ eventId: 'mid-2', status: 'processing' });
    });
  });

  describe('stale processing recovery', () => {
    it('atomically terminalizes a stale processing row', async () => {
      const { service, claimExecuteMock, claimWhereMock, claimAndWhereMock } =
        buildService();
      const staleBefore = new Date('2026-08-13T00:00:00Z');
      claimExecuteMock.mockResolvedValue({ affected: 1 });

      const abandoned = await service.abandonStaleProcessing(9, staleBefore);

      expect(abandoned).toBe(true);
      expect(claimWhereMock).toHaveBeenCalledWith('id = :id', { id: 9 });
      expect(claimAndWhereMock).toHaveBeenCalledWith(
        'status = :status AND updated_at < :staleBefore',
        { status: 'processing', staleBefore },
      );
    });

    it('marks processing completion as unknown without replaying it', async () => {
      const { service, claimExecuteMock, claimWhereMock, claimAndWhereMock } =
        buildService();
      claimExecuteMock.mockResolvedValue({ affected: 1 });

      const abandoned = await service.markProcessingAbandoned(
        9,
        'completion write failed',
      );

      expect(abandoned).toBe(true);
      expect(claimWhereMock).toHaveBeenCalledWith('id = :id', { id: 9 });
      expect(claimAndWhereMock).toHaveBeenCalledWith('status = :status', {
        status: 'processing',
      });
    });

    it('lists only stale processing rows and terminalizes the same row atomically', async () => {
      const now = new Date('2026-08-13T01:00:00Z');
      const staleBefore = new Date('2026-08-13T00:55:00Z');
      const rows = [
        {
          id: 1,
          platform: 'messenger' as const,
          eventId: 'stale',
          externalUserId: 'psid-stale',
          eventType: 'message',
          rawPayload: {},
          status: 'processing',
          retryCount: 0,
          nextRetryAt: null,
          updatedAt: new Date('2026-08-13T00:50:00Z'),
        },
        {
          id: 2,
          platform: 'messenger' as const,
          eventId: 'fresh',
          externalUserId: 'psid-fresh',
          eventType: 'message',
          rawPayload: {},
          status: 'processing',
          retryCount: 0,
          nextRetryAt: null,
          updatedAt: new Date('2026-08-13T00:59:00Z'),
        },
        {
          id: 3,
          platform: 'messenger' as const,
          eventId: 'pending',
          externalUserId: 'psid-pending',
          eventType: 'message',
          rawPayload: {},
          status: 'pending',
          retryCount: 0,
          nextRetryAt: null,
          updatedAt: new Date('2026-08-13T00:59:00Z'),
        },
      ];

      const listBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest
          .fn()
          .mockImplementation(() =>
            rows.filter(
              (row) =>
                (['pending', 'failed'].includes(row.status) &&
                  (row.nextRetryAt === null || row.nextRetryAt <= now)) ||
                (row.status === 'processing' && row.updatedAt < staleBefore),
            ),
          ),
      };
      let updateId: number | undefined;
      let updateStaleBefore: Date | undefined;
      const updateBuilder = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn((_condition: string, parameters: { id: number }) => {
          updateId = parameters.id;
          return updateBuilder;
        }),
        andWhere: jest.fn(
          (_condition: string, parameters: { staleBefore: Date }) => {
            updateStaleBefore = parameters.staleBefore;
            return updateBuilder;
          },
        ),
        execute: jest.fn(() => {
          const row = rows.find((candidate) => candidate.id === updateId);
          const canAbandon =
            row?.status === 'processing' &&
            updateStaleBefore !== undefined &&
            row.updatedAt < updateStaleBefore;
          if (canAbandon) row.status = 'abandoned';
          return { affected: canAbandon ? 1 : 0 };
        }),
      };
      const repo = {
        createQueryBuilder: jest.fn((alias?: string) =>
          alias
            ? listBuilder
            : {
                update: jest.fn(() => updateBuilder),
              },
        ),
      } as unknown as Repository<WebhookInboundEventEntity>;
      const service = new PlatformWebhookInboundEventService('messenger', repo);

      const due = await service.listDue({
        limit: 20,
        now,
        processingStuckMs: 5 * 60_000,
      });

      expect(due.map((row) => row.id)).toEqual([1, 3]);
      expect(await service.abandonStaleProcessing(1, staleBefore)).toBe(true);
      expect(rows[0].status).toBe('abandoned');
      expect(await service.abandonStaleProcessing(2, staleBefore)).toBe(false);
      expect(rows[1].status).toBe('processing');
    });
  });

  describe('deleteTerminalOlderThan', () => {
    it('deletes only terminal rows older than the cutoff for the platform', async () => {
      const deleteExecuteMock = jest.fn().mockResolvedValue({ affected: 3 });
      const deleteAndWhere2Mock = jest.fn(() => ({
        execute: deleteExecuteMock,
      }));
      const deleteAndWhere1Mock = jest.fn(() => ({
        andWhere: deleteAndWhere2Mock,
      }));
      const deleteWhereMock = jest.fn(() => ({
        andWhere: deleteAndWhere1Mock,
      }));
      const deleteFromMock = jest.fn(() => ({ where: deleteWhereMock }));
      const deleteMock = jest.fn(() => ({ from: deleteFromMock }));
      const createQueryBuilderMock = jest.fn(() => ({ delete: deleteMock }));
      const repo = {
        createQueryBuilder: createQueryBuilderMock,
      } as unknown as Repository<WebhookInboundEventEntity>;

      const service = new PlatformWebhookInboundEventService('messenger', repo);
      const cutoff = new Date('2026-01-01T00:00:00Z');
      const deleted = await service.deleteTerminalOlderThan(cutoff);

      expect(deleted).toBe(3);
      expect(deleteWhereMock).toHaveBeenCalledWith('platform = :platform', {
        platform: 'messenger',
      });
      expect(deleteAndWhere1Mock).toHaveBeenCalledWith(
        'status IN (:...statuses)',
        { statuses: ['completed', 'abandoned'] },
      );
      expect(deleteAndWhere2Mock).toHaveBeenCalledWith('created_at < :cutoff', {
        cutoff,
      });
    });
  });
});
