/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */

/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Jest mock internal access */

import {
  RescheduleConfirmationService,
  type CalendarPort,
  type ReschedulePort,
} from './reschedule-confirm.service';
import { MemoryRescheduleStore } from './reschedule-store.port';
import { WispaceDataCache } from '@wispace/wispace-client';

function mockCalendarPort(): CalendarPort<string> {
  return {
    listUpcomingEntries: jest.fn().mockResolvedValue([
      { calendarId: 1, scheduledTimeLabel: 'Hôm nay 14:00' },
      { calendarId: 2, scheduledTimeLabel: 'Ngày mai 10:00' },
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

    it('returns error for invalid calendarId', async () => {
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      const service = new RescheduleConfirmationService(calendar, reschedule);

      const result = await service.stage({
        externalId: 'user-1',
        userId: 42,
        calendarId: 999,
        schedulingMode: 'explicit',
      });

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('999');
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
  });

  describe('confirm', () => {
    it('binds production confirmations to the one-time token and mapping revision', async () => {
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

      const duplicate = await service.confirm('user-1', 42, token, {
        platform: 'discord',
        mappingVersion: '7:revision-a',
      });
      expect(duplicate.confirmed).toBe(false);
      expect(reschedule.rescheduleSession).toHaveBeenCalledTimes(1);
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
  });

  describe('TTL expiry', () => {
    it('rejects confirm after TTL expires', async () => {
      jest.useFakeTimers();
      try {
        const calendar = mockCalendarPort();
        const reschedule = mockReschedulePort();
        const service = new RescheduleConfirmationService(calendar, reschedule);

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
          message: expect.any(String),
        });
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

  describe('onConfirmed hook (#636 cache invalidation)', () => {
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
      const onConfirmed = jest.fn();
      const service = new RescheduleConfirmationService(
        calendar,
        reschedule,
        undefined,
        { onConfirmed },
      );

      await stageValid(service);
      const result = await service.confirm('user-1');

      expect(result.confirmed).toBe(true);
      expect(onConfirmed).toHaveBeenCalledTimes(1);
      expect(onConfirmed).toHaveBeenCalledWith('user-1');
    });

    it('does not fire when the write fails', async () => {
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      (reschedule.rescheduleSession as jest.Mock).mockRejectedValue(
        new Error('Wispace down'),
      );
      const onConfirmed = jest.fn();
      const service = new RescheduleConfirmationService(
        calendar,
        reschedule,
        undefined,
        { onConfirmed },
      );

      await stageValid(service);
      const result = await service.confirm('user-1');

      expect(result.confirmed).toBe(false);
      expect(onConfirmed).not.toHaveBeenCalled();
    });

    it('a hook failure must not fail the already-committed confirmation', async () => {
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      const onConfirmed = jest.fn().mockRejectedValue(new Error('cache down'));
      const service = new RescheduleConfirmationService(
        calendar,
        reschedule,
        undefined,
        { onConfirmed },
      );

      await stageValid(service);
      const result = await service.confirm('user-1');

      expect(result).toEqual({
        confirmed: true,
        scheduledTimeLabel: expect.any(String),
      });
      expect(onConfirmed).toHaveBeenCalledTimes(1);
    });
  });

  describe('read-your-writes (#636): reschedule then ask upcoming sessions', () => {
    it('the next cached calendar read after confirm returns the new schedule', async () => {
      const calendar = mockCalendarPort();
      const reschedule = mockReschedulePort();
      const cache = new WispaceDataCache();
      const onConfirmed = jest.fn((externalId: string) => {
        cache.invalidateUser(externalId, ['calendar']);
      });
      const service = new RescheduleConfirmationService(
        calendar,
        reschedule,
        undefined,
        { onConfirmed },
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
      expect(onConfirmed).toHaveBeenCalledWith('user-1');
    });
  });
});
