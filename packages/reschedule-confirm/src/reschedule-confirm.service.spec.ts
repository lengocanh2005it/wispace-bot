/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */

/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Jest mock internal access */

import { Logger } from '@nestjs/common';
import {
  RescheduleScopeError,
  RescheduleConfirmationService,
  type CalendarPort,
  type ReschedulePort,
} from './reschedule-confirm.service';
import {
  MemoryRescheduleStore,
  type RescheduleStorePort,
} from './reschedule-store.port';
import { WispaceDataCache } from '@wispace/wispace-client/core';

function mockCalendarPort(): CalendarPort<string> {
  return {
    listUpcomingEntries: jest.fn().mockResolvedValue([
      {
        calendarId: 1,
        scheduledTimeLabel: 'Hôm nay 14:00',
        ownerUserId: 42,
      },
      {
        calendarId: 2,
        scheduledTimeLabel: 'Ngày mai 10:00',
        ownerUserId: 42,
      },
    ]),
  };
}

function mockReschedulePort(): ReschedulePort<string> {
  return {
    rescheduleSession: jest.fn().mockResolvedValue({
      scheduledTimeLabel: '29/07/2026 lúc 15:00',
    }),
  };
}

function mockStore(saveResult: boolean): RescheduleStorePort<string> {
  return {
    requiresApprovalToken: false,
    save: jest.fn().mockResolvedValue(saveResult),
    takeValid: jest.fn().mockResolvedValue(null),
    revertToPending: jest.fn().mockResolvedValue(undefined),
    cancelPending: jest.fn().mockResolvedValue('cancelled'),
    cancelClaimed: jest.fn().mockResolvedValue(undefined),
    hasPending: jest.fn().mockResolvedValue(false),
  };
}

describe('RescheduleConfirmationService', () => {
  describe('stage', () => {
    it('returns pendingConfirmation with summary for valid calendarId', async () => {
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      const service = new RescheduleConfirmationService(calendar, reschedule);

      const result = await service.stage({
        externalId: 'user-1',
        userId: 42,
        calendarId: 1,
        schedulingMode: 'explicit',
        newLocalDate: '2026-07-29',
        newTime: '15:00',
      });

      expect(result).toEqual({
        pendingConfirmation: true,
        sessionLabel: 'Hôm nay 14:00',
        summary: 'Dời buổi Hôm nay 14:00 sang ngày 2026-07-29 lúc 15:00?',
      });
    });

    it('returns a conflict error when a confirmation is already processing', async () => {
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      const store = mockStore(false);
      const service = new RescheduleConfirmationService(
        calendar,
        reschedule,
        store,
      );

      const result = await service.stage({
        externalId: 'user-1',
        userId: 42,
        calendarId: 1,
        schedulingMode: 'explicit',
      });

      expect(result).toEqual({
        error: 'Yêu cầu đổi lịch trước đang được xử lý. Bạn thử lại sau nhé.',
      });
    });

    it('returns error for invalid calendarId', async () => {
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      const scopeFailureInc = jest.fn();
      const service = new RescheduleConfirmationService(
        calendar,
        reschedule,
        undefined,
        { scopeFailureInc },
      );

      const result = await service.stage({
        externalId: 'user-1',
        userId: 42,
        calendarId: 999,
        schedulingMode: 'explicit',
      });

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).not.toContain('999');
      expect(scopeFailureInc).toHaveBeenCalledWith('scope_unverified');
    });

    it('rejects a calendar entry owned by another WISPACE user before staging', async () => {
      const calendar: CalendarPort<string> = {
        listUpcomingEntries: jest.fn().mockResolvedValue([
          {
            calendarId: 99,
            scheduledTimeLabel: 'Ngày mai 10:00',
            ownerUserId: 7,
          },
        ]),
      };
      const reschedule = mockReschedulePort();
      const service = new RescheduleConfirmationService(calendar, reschedule);

      const result = await service.stage({
        externalId: 'user-1',
        userId: 42,
        calendarId: 99,
        schedulingMode: 'explicit',
      });

      expect(result).toEqual({
        error:
          'Không thể xác thực buổi học này trong lịch của bạn. Bạn chọn lại từ danh sách lịch học nhé.',
      });
      expect(reschedule.rescheduleSession).not.toHaveBeenCalled();
    });

    it('rejects an entry without valid ownership proof before staging', async () => {
      const calendar: CalendarPort<string> = {
        listUpcomingEntries: jest.fn().mockResolvedValue([
          {
            calendarId: 99,
            scheduledTimeLabel: 'Ngày mai 10:00',
          },
        ]),
      };
      const reschedule = mockReschedulePort();
      const service = new RescheduleConfirmationService(calendar, reschedule);

      const result = await service.stage({
        externalId: 'user-1',
        userId: 42,
        calendarId: 99,
        schedulingMode: 'explicit',
      });

      expect(result).toEqual({
        error:
          'Không thể xác thực buổi học này trong lịch của bạn. Bạn chọn lại từ danh sách lịch học nhé.',
      });
      expect(reschedule.rescheduleSession).not.toHaveBeenCalled();
    });

    it('records a masked scope denial when ownership does not match', async () => {
      const calendar: CalendarPort<string> = {
        listUpcomingEntries: jest.fn().mockResolvedValue([
          {
            calendarId: 99,
            scheduledTimeLabel: 'Ngày mai 10:00',
            ownerUserId: 7,
          },
        ]),
      };
      const scopeFailureInc = jest.fn();
      const service = new RescheduleConfirmationService(
        calendar,
        mockReschedulePort(),
        undefined,
        { scopeFailureInc },
      );

      await service.stage({
        externalId: 'user-1',
        userId: 42,
        calendarId: 99,
        schedulingMode: 'explicit',
      });

      expect(scopeFailureInc).toHaveBeenCalledWith('scope_mismatch');
    });

    it('builds next-slot summary for default_next_day_same_time mode', async () => {
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      const service = new RescheduleConfirmationService(calendar, reschedule);

      const result = await service.stage({
        externalId: 'user-1',
        userId: 42,
        calendarId: 1,
        schedulingMode: 'default_next_day_same_time',
      });

      expect(result).toEqual({
        pendingConfirmation: true,
        sessionLabel: 'Hôm nay 14:00',
        summary: 'Dời buổi Hôm nay 14:00 sang ngày kế tiếp cùng giờ?',
      });
    });

    it('rejects missing approval metadata before reading the calendar', async () => {
      const calendar = mockCalendarPort();
      const store = new MemoryRescheduleStore<string>();
      (store as { requiresApprovalToken?: boolean }).requiresApprovalToken =
        true;
      const service = new RescheduleConfirmationService(
        calendar,
        mockReschedulePort(),
        store,
      );

      const result = await service.stage({
        externalId: 'user-1',
        userId: 42,
        calendarId: 1,
        schedulingMode: 'explicit',
      });

      expect(result).toEqual({
        error:
          'Không thể xác thực yêu cầu đổi lịch này. Bạn nhắn lại nhu cầu đổi lịch nhé.',
      });
      expect(calendar.listUpcomingEntries).not.toHaveBeenCalled();
    });

    it('rejects before reading the calendar when the stage signal is already aborted', async () => {
      const calendar = mockCalendarPort();
      const store = mockStore(true);
      const service = new RescheduleConfirmationService(
        calendar,
        mockReschedulePort(),
        store,
      );
      const controller = new AbortController();
      controller.abort();

      await expect(
        service.stage({
          externalId: 'user-1',
          userId: 42,
          calendarId: 1,
          schedulingMode: 'explicit',
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });

      expect(calendar.listUpcomingEntries).not.toHaveBeenCalled();
      expect(store.save).not.toHaveBeenCalled();
    });

    it('stops after a cancelled calendar read and forwards the signal', async () => {
      let release!: (
        entries: Array<{
          calendarId: number;
          scheduledTimeLabel: string;
          ownerUserId: number;
        }>,
      ) => void;
      const calendar = {
        listUpcomingEntries: jest.fn(
          () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        ),
      } as unknown as CalendarPort<string>;
      const store = mockStore(true);
      const service = new RescheduleConfirmationService(
        calendar,
        mockReschedulePort(),
        store,
      );
      const controller = new AbortController();
      const pending = service.stage({
        externalId: 'user-1',
        userId: 42,
        calendarId: 1,
        schedulingMode: 'explicit',
        signal: controller.signal,
      });

      await Promise.resolve();
      expect(calendar.listUpcomingEntries).toHaveBeenCalledWith('user-1', 42, {
        signal: controller.signal,
      });
      controller.abort();
      release([
        { calendarId: 1, scheduledTimeLabel: 'Hôm nay 14:00', ownerUserId: 42 },
      ]);

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(store.save).not.toHaveBeenCalled();
    });

    it('conditionally cleans a late save after cancellation', async () => {
      let release!: (saved: boolean) => void;
      const calendar = mockCalendarPort();
      const store = mockStore(true);
      (store.save as jest.Mock).mockImplementation(
        (_pending: unknown, options: { signal?: AbortSignal }) => {
          expect(options.signal).toBeInstanceOf(AbortSignal);
          return new Promise<boolean>((resolve) => {
            release = resolve;
          });
        },
      );
      const service = new RescheduleConfirmationService(
        calendar,
        mockReschedulePort(),
        store,
      );
      const controller = new AbortController();
      const pending = service.stage({
        externalId: 'user-1',
        userId: 42,
        calendarId: 1,
        schedulingMode: 'explicit',
        signal: controller.signal,
      });

      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();
      release(true);

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(store.cancelPending).toHaveBeenCalledWith(
        'user-1',
        expect.stringMatching(/^[0-9a-f-]{36}$/),
      );
    });

    it('forwards the signal on the normal stage path', async () => {
      const calendar = mockCalendarPort();
      const store = mockStore(true);
      const service = new RescheduleConfirmationService(
        calendar,
        mockReschedulePort(),
        store,
      );
      const controller = new AbortController();

      await service.stage({
        externalId: 'user-1',
        userId: 42,
        calendarId: 1,
        schedulingMode: 'explicit',
        signal: controller.signal,
      });

      expect(calendar.listUpcomingEntries).toHaveBeenCalledWith('user-1', 42, {
        signal: controller.signal,
      });
      expect(store.save).toHaveBeenCalledWith(
        expect.objectContaining({ calendarId: 1 }),
        { signal: controller.signal },
      );
    });
  });

  describe('abort cleanup', () => {
    it('retries cleanup once after a transient failure', async () => {
      const store = mockStore(true);
      (store.cancelPending as jest.Mock)
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce(undefined);
      const service = new RescheduleConfirmationService(
        mockCalendarPort(),
        mockReschedulePort(),
        store,
      );

      await expect(
        service.cancelPending('user-1', 'nonce-1'),
      ).resolves.toBeUndefined();
      expect(store.cancelPending).toHaveBeenCalledTimes(2);
      expect(store.cancelPending).toHaveBeenNthCalledWith(
        1,
        'user-1',
        'nonce-1',
      );
      expect(store.cancelPending).toHaveBeenNthCalledWith(
        2,
        'user-1',
        'nonce-1',
      );
    });

    it('logs and swallows a cleanup failure after the bounded retry', async () => {
      const store = mockStore(true);
      (store.cancelPending as jest.Mock).mockRejectedValue(
        new Error('database unavailable'),
      );
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        const service = new RescheduleConfirmationService(
          mockCalendarPort(),
          mockReschedulePort(),
          store,
        );

        await expect(
          service.cancelPending('user-1', 'nonce-1'),
        ).resolves.toBeUndefined();
        expect(store.cancelPending).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('RESCHEDULE_ABORT_CLEANUP_FAILED'),
        );
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('confirm', () => {
    it('binds production confirmations to the one-time token and mapping revision', async () => {
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      const store = new MemoryRescheduleStore<string>();
      (store as { requiresApprovalToken?: boolean }).requiresApprovalToken =
        true;
      const calendarCacheInvalidation = jest.fn();
      const service = new RescheduleConfirmationService(
        calendar,
        reschedule,
        store,
        {
          calendarCacheInvalidation: {
            invalidateCalendar: calendarCacheInvalidation,
          },
        },
      );

      const staged = await service.stage({
        externalId: 'user-1',
        userId: 42,
        calendarId: 1,
        schedulingMode: 'explicit',
        platform: 'discord',
        mappingVersion: '7:revision-a',
        intent: 'mình muốn đổi lịch học',
        canonicalArgs: '{"calendarId":1}',
      });
      const token = (staged as { confirmationToken: string }).confirmationToken;

      const wrong = await service.confirm('user-1', 42, 'wrong', {
        platform: 'discord',
        mappingVersion: '7:revision-a',
      });
      expect(wrong.confirmed).toBe(false);
      expect(reschedule.rescheduleSession).not.toHaveBeenCalled();

      const wrongPlatform = await service.confirm('user-1', 42, token, {
        platform: 'zalo',
        mappingVersion: '7:revision-a',
      });
      expect(wrongPlatform.confirmed).toBe(false);
      expect(reschedule.rescheduleSession).not.toHaveBeenCalled();

      const confirmed = await service.confirm('user-1', 42, token, {
        platform: 'discord',
        mappingVersion: '7:revision-a',
      });
      expect(confirmed.confirmed).toBe(true);
      expect(reschedule.rescheduleSession).toHaveBeenCalledTimes(1);
      expect(calendarCacheInvalidation).toHaveBeenCalledTimes(1);

      const duplicate = await service.confirm('user-1', 42, token, {
        platform: 'discord',
        mappingVersion: '7:revision-a',
      });
      expect(duplicate.confirmed).toBe(false);
      expect(reschedule.rescheduleSession).toHaveBeenCalledTimes(1);
      expect(calendarCacheInvalidation).toHaveBeenCalledTimes(1);
    });

    it('rejects malformed approval tokens before claiming storage', async () => {
      const store = new MemoryRescheduleStore<string>();
      (store as { requiresApprovalToken?: boolean }).requiresApprovalToken =
        true;
      const takeValid = jest.spyOn(store, 'takeValid');
      const service = new RescheduleConfirmationService(
        mockCalendarPort(),
        mockReschedulePort(),
        store,
      );

      const result = await service.confirm('user-1', 42, 'not-a-uuid', {
        platform: 'discord',
        mappingVersion: '7:revision-a',
      });

      expect(result.confirmed).toBe(false);
      expect(takeValid).not.toHaveBeenCalled();
    });

    it('invalidates the previous token when a new argument set is staged', async () => {
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      const store = new MemoryRescheduleStore<string>();
      (store as { requiresApprovalToken?: boolean }).requiresApprovalToken =
        true;
      const service = new RescheduleConfirmationService(
        calendar,
        reschedule,
        store,
      );

      const first = await service.stage({
        externalId: 'user-1',
        userId: 42,
        calendarId: 1,
        schedulingMode: 'explicit',
        platform: 'discord',
        mappingVersion: '7:revision-a',
        intent: 'đổi lịch',
        canonicalArgs: '{"calendarId":1}',
      });
      const firstToken = (first as { confirmationToken: string })
        .confirmationToken;

      const second = await service.stage({
        externalId: 'user-1',
        userId: 42,
        calendarId: 2,
        schedulingMode: 'explicit',
        platform: 'discord',
        mappingVersion: '7:revision-a',
        intent: 'đổi lịch ngày mai',
        canonicalArgs: '{"calendarId":2}',
      });
      const secondToken = (second as { confirmationToken: string })
        .confirmationToken;

      const stale = await service.confirm('user-1', 42, firstToken, {
        platform: 'discord',
        mappingVersion: '7:revision-a',
      });
      expect(stale.confirmed).toBe(false);
      expect(reschedule.rescheduleSession).not.toHaveBeenCalled();

      const current = await service.confirm('user-1', 42, secondToken, {
        platform: 'discord',
        mappingVersion: '7:revision-a',
      });
      expect(current.confirmed).toBe(true);
      expect(reschedule.rescheduleSession).toHaveBeenCalledWith(
        expect.objectContaining({ calendarId: 2 }),
      );
    });

    it('executes reschedule and returns scheduledTimeLabel', async () => {
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      const service = new RescheduleConfirmationService(calendar, reschedule);

      await service.stage({
        externalId: 'user-1',
        userId: 42,
        calendarId: 1,
        schedulingMode: 'explicit',
        newLocalDate: '2026-07-29',
        newTime: '15:00',
      });

      const result = await service.confirm('user-1');

      expect(result).toEqual({
        confirmed: true,
        scheduledTimeLabel: '29/07/2026 lúc 15:00',
      });
      expect(reschedule.rescheduleSession).toHaveBeenCalledWith({
        externalId: 'user-1',
        userId: 42,
        calendarId: 1,
        schedulingMode: 'explicit',
        newLocalDate: '2026-07-29',
        newTime: '15:00',
      });
    });

    it('deletes a confirmed row through the claimed lease path', async () => {
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      const store = mockStore(true);
      (store.takeValid as jest.Mock).mockResolvedValue({
        externalId: 'user-1',
        userId: 42,
        calendarId: 1,
        schedulingMode: 'explicit',
        sessionLabel: 'Hôm nay 14:00',
        expiresAt: Date.now() + 60_000,
        leaseToken: 'lease-1',
      });
      const service = new RescheduleConfirmationService(
        calendar,
        reschedule,
        store,
      );

      const result = await service.confirm('user-1');

      expect(result).toEqual({
        confirmed: true,
        scheduledTimeLabel: '29/07/2026 lúc 15:00',
      });
      expect(store.cancelClaimed).toHaveBeenCalledWith('user-1', 'lease-1');
      expect(store.cancelPending).not.toHaveBeenCalled();
    });

    it('returns error when no pending reschedule', async () => {
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      const service = new RescheduleConfirmationService(calendar, reschedule);

      const result = await service.confirm('user-1');

      expect(result).toEqual({
        confirmed: false,
        message: expect.any(String),
      });
    });

    it('returns error when reschedule fails', async () => {
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      (reschedule.rescheduleSession as jest.Mock).mockRejectedValue(
        new Error('API down'),
      );
      const service = new RescheduleConfirmationService(calendar, reschedule);

      await service.stage({
        externalId: 'user-1',
        userId: 42,
        calendarId: 1,
        schedulingMode: 'explicit',
      });

      const result = await service.confirm('user-1');

      expect(result).toEqual({
        confirmed: false,
        message: expect.any(String),
      });
    });

    it('cancels a pending request when the write scope cannot be verified', async () => {
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      (reschedule.rescheduleSession as jest.Mock).mockRejectedValue(
        new RescheduleScopeError('scope_mismatch'),
      );
      const store = new MemoryRescheduleStore<string>();
      const scopeFailureInc = jest.fn();
      const calendarCacheInvalidation = jest.fn();
      const service = new RescheduleConfirmationService(
        calendar,
        reschedule,
        store,
        {
          scopeFailureInc,
          calendarCacheInvalidation: {
            invalidateCalendar: calendarCacheInvalidation,
          },
        },
      );

      await service.stage({
        externalId: 'user-1',
        userId: 42,
        calendarId: 1,
        schedulingMode: 'explicit',
      });

      const result = await service.confirm('user-1');

      expect(result).toEqual({
        confirmed: false,
        message:
          'Không thể xác thực buổi học này trong lịch của bạn. Bạn chọn lại từ danh sách lịch học nhé.',
      });
      expect(scopeFailureInc).toHaveBeenCalledWith('scope_mismatch');
      expect(calendarCacheInvalidation).not.toHaveBeenCalled();
      expect(await service.hasPending('user-1')).toBe(false);
    });

    it('clears pending after confirm', async () => {
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      const service = new RescheduleConfirmationService(calendar, reschedule);

      await service.stage({
        externalId: 'user-1',
        userId: 42,
        calendarId: 1,
        schedulingMode: 'explicit',
      });

      await service.confirm('user-1');
      const second = await service.confirm('user-1');

      expect(second).toEqual({
        confirmed: false,
        message: expect.any(String),
      });
    });
  });

  describe('cancel', () => {
    it('clears pending and returns cancel message', async () => {
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      const service = new RescheduleConfirmationService(calendar, reschedule);

      await service.stage({
        externalId: 'user-1',
        userId: 42,
        calendarId: 1,
        schedulingMode: 'explicit',
      });

      const msg = await service.cancel('user-1');
      expect(msg).toContain('hủy');

      const confirm = await service.confirm('user-1');
      expect(confirm).toEqual({
        confirmed: false,
        message: expect.any(String),
      });
    });

    it('reports expiry when cancellation is the first related interaction', async () => {
      jest.useFakeTimers();
      try {
        const service = new RescheduleConfirmationService(
          mockCalendarPort(),
          mockReschedulePort(),
        );

        await service.stage({
          externalId: 'user-1',
          userId: 42,
          calendarId: 1,
          schedulingMode: 'explicit',
        });
        jest.advanceTimersByTime(11 * 60 * 1000);

        await expect(service.cancel('user-1')).resolves.toContain('hết hạn');
      } finally {
        jest.useRealTimers();
      }
    });

    it('uses pending cancellation without passing the approval nonce as a lease', async () => {
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      const store = mockStore(true);
      (store as { requiresApprovalToken?: boolean }).requiresApprovalToken =
        true;
      const service = new RescheduleConfirmationService(
        calendar,
        reschedule,
        store,
      );

      const msg = await service.cancel(
        'user-1',
        '00000000-0000-4000-8000-000000000000',
      );

      expect(msg).toContain('hủy');
      expect(store.cancelPending).toHaveBeenCalledWith(
        'user-1',
        '00000000-0000-4000-8000-000000000000',
      );
      expect(store.cancelClaimed).not.toHaveBeenCalled();
    });
  });

  describe('TTL expiry', () => {
    it('rejects confirm after TTL expires', async () => {
      jest.useFakeTimers();
      try {
        const calendar = mockCalendarPort();
        const reschedule = mockReschedulePort();
        const calendarCacheInvalidation = jest.fn();
        const service = new RescheduleConfirmationService(
          calendar,
          reschedule,
          undefined,
          {
            calendarCacheInvalidation: {
              invalidateCalendar: calendarCacheInvalidation,
            },
          },
        );

        await service.stage({
          externalId: 'user-1',
          userId: 42,
          calendarId: 1,
          schedulingMode: 'explicit',
        });

        jest.setSystemTime(new Date(Date.now() + 11 * 60 * 1000));

        const result = await service.confirm('user-1');
        expect(result).toEqual({
          confirmed: false,
          message: expect.stringContaining('hết hạn'),
        });
        expect(calendarCacheInvalidation).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('confirm failure keeps the request pending (retryable)', () => {
    it('lets the user confirm again after a transient reschedule failure', async () => {
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      (reschedule.rescheduleSession as jest.Mock)
        .mockRejectedValueOnce(new Error('Wispace down'))
        .mockResolvedValueOnce({ scheduledTimeLabel: 'Ngày mai lúc 19:00' });
      const service = new RescheduleConfirmationService(calendar, reschedule);

      await service.stage({
        externalId: 'user-1',
        userId: 42,
        calendarId: 1,
        schedulingMode: 'explicit',
      });

      const first = await service.confirm('user-1');
      expect(first.confirmed).toBe(false);

      const second = await service.confirm('user-1');
      expect(second).toEqual({
        confirmed: true,
        scheduledTimeLabel: 'Ngày mai lúc 19:00',
      });
    });
  });

  describe('calendar cache invalidation (#705)', () => {
    const stageValid = (service: RescheduleConfirmationService<string>) =>
      service.stage({
        externalId: 'user-1',
        userId: 42,
        calendarId: 1,
        schedulingMode: 'explicit',
      });

    it('fires after a successful write with the external id', async () => {
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      const calendarCacheInvalidation = jest.fn();
      const service = new RescheduleConfirmationService(
        calendar,
        reschedule,
        undefined,
        {
          calendarCacheInvalidation: {
            invalidateCalendar: calendarCacheInvalidation,
          },
        },
      );

      await stageValid(service);
      expect(calendarCacheInvalidation).not.toHaveBeenCalled();
      const result = await service.confirm('user-1');

      expect(result.confirmed).toBe(true);
      expect(calendarCacheInvalidation).toHaveBeenCalledTimes(1);
      expect(calendarCacheInvalidation).toHaveBeenCalledWith('user-1');
    });

    it('does not fire when the write fails', async () => {
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      (reschedule.rescheduleSession as jest.Mock).mockRejectedValue(
        new Error('Wispace down'),
      );
      const calendarCacheInvalidation = jest.fn();
      const service = new RescheduleConfirmationService(
        calendar,
        reschedule,
        undefined,
        {
          calendarCacheInvalidation: {
            invalidateCalendar: calendarCacheInvalidation,
          },
        },
      );

      await stageValid(service);
      const result = await service.confirm('user-1');

      expect(result.confirmed).toBe(false);
      expect(calendarCacheInvalidation).not.toHaveBeenCalled();
    });

    it('an invalidation failure must not fail the already-committed confirmation', async () => {
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      const calendarCacheInvalidation = jest.fn().mockImplementation(() => {
        throw new Error('cache down');
      });
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        const service = new RescheduleConfirmationService(
          calendar,
          reschedule,
          undefined,
          {
            calendarCacheInvalidation: {
              invalidateCalendar: calendarCacheInvalidation,
            },
          },
        );

        await stageValid(service);
        const result = await service.confirm('user-1');

        expect(result).toEqual({
          confirmed: true,
          scheduledTimeLabel: expect.any(String),
        });
        expect(calendarCacheInvalidation).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(
            'RESCHEDULE_CALENDAR_CACHE_INVALIDATION_FAILED',
          ),
        );
      } finally {
        warn.mockRestore();
      }
    });

    it('invalidates once after write and claim cleanup, including duplicate confirms', async () => {
      const events: string[] = [];
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      (reschedule.rescheduleSession as jest.Mock).mockImplementation(
        async () => {
          events.push('write');
          return { scheduledTimeLabel: '29/07/2026 lúc 15:00' };
        },
      );
      const store = new MemoryRescheduleStore<string>();
      const originalCancelClaimed = store.cancelClaimed.bind(store);
      jest.spyOn(store, 'cancelClaimed').mockImplementation(async (...args) => {
        events.push('cleanup');
        await originalCancelClaimed(...args);
      });
      const calendarCacheInvalidation = jest.fn(() => {
        events.push('invalidate');
      });
      const service = new RescheduleConfirmationService(
        calendar,
        reschedule,
        store,
        {
          calendarCacheInvalidation: {
            invalidateCalendar: calendarCacheInvalidation,
          },
        },
      );

      await stageValid(service);
      const [first, duplicate] = await Promise.all([
        service.confirm('user-1'),
        service.confirm('user-1'),
      ]);

      expect([first.confirmed, duplicate.confirmed].sort()).toEqual([
        false,
        true,
      ]);
      expect(events).toEqual(['write', 'cleanup', 'invalidate']);
      expect(calendarCacheInvalidation).toHaveBeenCalledTimes(1);
    });
  });

  describe('read-your-writes (#636): reschedule then ask upcoming sessions', () => {
    it('the next cached calendar read after confirm returns the new schedule', async () => {
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      const cache = new WispaceDataCache();
      const calendarCacheInvalidation = jest.fn((externalId: string) => {
        cache.invalidateUser(externalId, ['calendar']);
      });
      const service = new RescheduleConfirmationService(
        calendar,
        reschedule,
        undefined,
        {
          calendarCacheInvalidation: {
            invalidateCalendar: calendarCacheInvalidation,
          },
        },
      );

      // The same read path the chat tools use: cache.getOrFetch('calendar').
      const upstream = jest
        .fn()
        .mockResolvedValueOnce([{ calendarId: 1, label: 'Hôm nay 14:00' }])
        .mockResolvedValueOnce([{ calendarId: 1, label: 'Ngày mai 10:00' }]);
      const askUpcomingSessions = () =>
        cache.getOrFetch('calendar', 'user-1', undefined, upstream);

      // Pre-mutation conversation read — cached.
      expect(await askUpcomingSessions()).toEqual([
        { calendarId: 1, label: 'Hôm nay 14:00' },
      ]);

      await service.stage({
        externalId: 'user-1',
        userId: 42,
        calendarId: 1,
        schedulingMode: 'explicit',
      });
      const result = await service.confirm('user-1');
      expect(result.confirmed).toBe(true);

      // Post-mutation read must reflect the new schedule, not the cache.
      expect(await askUpcomingSessions()).toEqual([
        { calendarId: 1, label: 'Ngày mai 10:00' },
      ]);
      expect(upstream).toHaveBeenCalledTimes(2);
      expect(calendarCacheInvalidation).toHaveBeenCalledWith('user-1');
    });
  });
  describe('write-tool daily budget at confirm time (#626)', () => {
    const FIXED_MSG =
      'Bạn đã dùng hết số lần đổi lịch học trong hôm nay rồi. Bạn thử lại vào ngày mai nhé.';
    const EXTERNAL_ID = 'user-1';
    const USER_ID = 42;
    const BINDING = { platform: 'discord' as const, mappingVersion: 'v1' };

    async function stageAPendingReschedule(
      svc: RescheduleConfirmationService<string>,
    ): Promise<string> {
      const staged = await svc.stage({
        externalId: EXTERNAL_ID,
        userId: USER_ID,
        calendarId: 1,
        schedulingMode: 'default_next_day_same_time',
        platform: 'discord',
        mappingVersion: 'v1',
        intent: 'đổi lịch học',
        canonicalArgs: '{"calendarId":1}',
      });
      return (staged as { confirmationToken: string }).confirmationToken;
    }

    it('aborts the reschedule and reverts the pending row when the daily budget is exhausted', async () => {
      const consume = jest.fn().mockResolvedValue(false);
      const reschedulePort = mockReschedulePort();
      const store = new MemoryRescheduleStore<string>();
      (store as { requiresApprovalToken?: boolean }).requiresApprovalToken =
        true;
      const revertSpy = jest.spyOn(store, 'revertToPending');
      const svc = new RescheduleConfirmationService(
        mockCalendarPort(),
        reschedulePort,
        store,
        {
          consumeRescheduleBudget: consume,
          rescheduleBudgetExceededMessage: FIXED_MSG,
        },
      );
      const token = await stageAPendingReschedule(svc);
      const result = await svc.confirm(EXTERNAL_ID, USER_ID, token, BINDING);
      expect(result).toEqual({ confirmed: false, message: FIXED_MSG });
      expect(reschedulePort.rescheduleSession).not.toHaveBeenCalled();
      expect(revertSpy).toHaveBeenCalled();
      expect(consume).toHaveBeenCalledWith(USER_ID, EXTERNAL_ID);
    });

    it('consumes exactly one unit on a successful confirm', async () => {
      const consume = jest.fn().mockResolvedValue(true);
      const refund = jest.fn();
      const reschedulePort = mockReschedulePort();
      const store = new MemoryRescheduleStore<string>();
      (store as { requiresApprovalToken?: boolean }).requiresApprovalToken =
        true;
      const svc = new RescheduleConfirmationService(
        mockCalendarPort(),
        reschedulePort,
        store,
        { consumeRescheduleBudget: consume, refundRescheduleBudget: refund },
      );
      const token = await stageAPendingReschedule(svc);
      const result = await svc.confirm(EXTERNAL_ID, USER_ID, token, BINDING);
      expect(result.confirmed).toBe(true);
      expect(consume).toHaveBeenCalledWith(USER_ID, EXTERNAL_ID);
      expect(refund).not.toHaveBeenCalled();
    });

    it('refunds the consumed unit when the calendar write throws', async () => {
      const consume = jest.fn().mockResolvedValue(true);
      const refund = jest.fn().mockResolvedValue(undefined);
      const reschedulePort = mockReschedulePort();
      (reschedulePort.rescheduleSession as jest.Mock).mockRejectedValue(
        new Error('WISPACE 500'),
      );
      const store = new MemoryRescheduleStore<string>();
      (store as { requiresApprovalToken?: boolean }).requiresApprovalToken =
        true;
      const svc = new RescheduleConfirmationService(
        mockCalendarPort(),
        reschedulePort,
        store,
        { consumeRescheduleBudget: consume, refundRescheduleBudget: refund },
      );
      const token = await stageAPendingReschedule(svc);
      const result = await svc.confirm(EXTERNAL_ID, USER_ID, token, BINDING);
      expect(result.confirmed).toBe(false);
      expect(refund).toHaveBeenCalledWith(USER_ID, EXTERNAL_ID);
    });

    it('is unchanged when no budget hooks are provided', async () => {
      const store = new MemoryRescheduleStore<string>();
      (store as { requiresApprovalToken?: boolean }).requiresApprovalToken =
        true;
      const svc = new RescheduleConfirmationService(
        mockCalendarPort(),
        mockReschedulePort(),
        store,
        {},
      );
      const token = await stageAPendingReschedule(svc);
      const result = await svc.confirm(EXTERNAL_ID, USER_ID, token, BINDING);
      expect(result.confirmed).toBe(true);
    });
  });
});
