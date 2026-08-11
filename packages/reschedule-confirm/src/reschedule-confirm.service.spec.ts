/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */

/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Jest mock internal access */

import {
  RescheduleConfirmationService,
  type CalendarPort,
  type ReschedulePort,
} from './reschedule-confirm.service';

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
  });

  describe('confirm', () => {
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
});
