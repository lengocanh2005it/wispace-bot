import { MessengerRescheduleConfirmationService } from './messenger-reschedule-confirmation.service';
import type { CalendarPort, ReschedulePort } from '@wispace/reschedule-confirm';

describe('MessengerRescheduleConfirmationService', () => {
  const createService = (
    calendarPort: CalendarPort<string>,
    reschedulePort: ReschedulePort<string>,
  ) => {
    return new MessengerRescheduleConfirmationService(
      calendarPort,
      reschedulePort,
    );
  };

  it('stages pending reschedule with confirm buttons', async () => {
    const service = createService(
      {
        listUpcomingEntries: jest.fn(() =>
          Promise.resolve([
            {
              calendarId: 42,
              scheduledTimeLabel: 'Ngày mai lúc 09:00',
              ownerUserId: 143,
            },
          ]),
        ),
      },
      { rescheduleSession: jest.fn() },
    );

    const result = await service.stage({
      externalId: 'psid-1',
      userId: 143,
      calendarId: 42,
      schedulingMode: 'default_next_day_same_time',
    });

    expect(result).toMatchObject({
      pendingConfirmation: true,
      sessionLabel: 'Ngày mai lúc 09:00',
    });
    if (!('richFollowUp' in result)) {
      throw new Error('expected staged reschedule result');
    }
  });

  it('confirms staged reschedule', async () => {
    const rescheduleSession = jest.fn(() =>
      Promise.resolve({ scheduledTimeLabel: 'Ngày mai lúc 09:00' }),
    );

    const service = createService(
      {
        listUpcomingEntries: jest.fn(() =>
          Promise.resolve([
            {
              calendarId: 42,
              scheduledTimeLabel: 'Ngày mai lúc 09:00',
              ownerUserId: 143,
            },
          ]),
        ),
      },
      { rescheduleSession },
    );

    await service.stage({
      externalId: 'psid-1',
      userId: 143,
      calendarId: 42,
      schedulingMode: 'default_next_day_same_time',
    });

    const confirmResult = await service.confirm('psid-1', 143);

    expect(confirmResult).toEqual({
      confirmed: true,
      scheduledTimeLabel: 'Ngày mai lúc 09:00',
    });
    expect(rescheduleSession).toHaveBeenCalledWith({
      externalId: 'psid-1',
      userId: 143,
      calendarId: 42,
      schedulingMode: 'default_next_day_same_time',
      newLocalDate: undefined,
      newTime: undefined,
    });
  });

  it('returns error when calendarId not found', async () => {
    const service = createService(
      {
        listUpcomingEntries: jest.fn(() =>
          Promise.resolve([
            {
              calendarId: 42,
              scheduledTimeLabel: 'Ngày mai lúc 09:00',
            },
          ]),
        ),
      },
      { rescheduleSession: jest.fn() },
    );

    const result = await service.stage({
      externalId: 'psid-1',
      userId: 143,
      calendarId: 999,
      schedulingMode: 'default_next_day_same_time',
    });

    expect(result).toMatchObject({
      error:
        'Không thể xác thực buổi học này trong lịch của bạn. Bạn chọn lại từ danh sách lịch học nhé.',
    });
  });

  it('cancels staged reschedule', async () => {
    const service = createService(
      {
        listUpcomingEntries: jest.fn(() =>
          Promise.resolve([
            {
              calendarId: 42,
              scheduledTimeLabel: 'Ngày mai lúc 09:00',
              ownerUserId: 143,
            },
          ]),
        ),
      },
      { rescheduleSession: jest.fn() },
    );

    await service.stage({
      externalId: 'psid-1',
      userId: 143,
      calendarId: 42,
      schedulingMode: 'default_next_day_same_time',
    });

    const cancelResult = await service.cancel('psid-1');

    expect(cancelResult).toContain('hủy');
  });
});
