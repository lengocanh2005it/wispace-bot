import { BadRequestException } from '@nestjs/common';
import {
  PlatformStudyCalendarCommandService,
  StudyReminderScheduleService,
} from '@wispace/study-reminder-shared';
import {
  closeKeepAliveAgents,
  WispaceCalendarService,
  WispaceConfigService,
} from '@wispace/wispace-client';
import { ConfigService } from '@nestjs/config';
import { StudyReminderModule } from './study-reminder.module';
import { WispaceModule } from '../wispace/wispace.module';

type FactoryProvider = {
  provide: unknown;
  useFactory?: (...args: unknown[]) => unknown;
  inject?: unknown[];
};

function findFactoryProvider(
  module: object,
  token: unknown,
): FactoryProvider | undefined {
  const providers = (Reflect.getMetadata('providers', module) ?? []) as Array<
    FactoryProvider | unknown
  >;
  return providers.find(
    (provider): provider is FactoryProvider =>
      typeof provider === 'object' &&
      provider !== null &&
      'provide' in provider &&
      provider.provide === token &&
      'useFactory' in provider &&
      typeof provider.useFactory === 'function',
  );
}

describe('Messenger study-reminder calendar wiring', () => {
  const originalFetch = global.fetch;

  afterEach(async () => {
    global.fetch = originalFetch;
    jest.useRealTimers();
    await closeKeepAliveAgents();
  });

  it('binds the shared command to Messenger WISPACE and schedule policy', async () => {
    const binding = findFactoryProvider(
      StudyReminderModule,
      PlatformStudyCalendarCommandService,
    );
    expect(binding).toBeDefined();
    expect(binding?.inject).toEqual([
      WispaceCalendarService,
      StudyReminderScheduleService,
    ]);

    const calendarService = {
      listCalendars: jest
        .fn()
        .mockResolvedValue([
          { id: 1, userId: 7, eventDate: '2099-01-01', time: '10:00' },
        ]),
      getCalendarSessions: jest.fn(),
      findCalendarRecord: jest.fn(),
      createCalendar: jest.fn(),
      deleteCalendar: jest.fn(),
    };
    const scheduleService = {
      getOutboxSettings: jest.fn(() => ({
        timezone: 'UTC',
        minLeadMinutes: Number.MAX_SAFE_INTEGER,
      })),
    };
    const command = binding!.useFactory!(
      calendarService,
      scheduleService,
    ) as PlatformStudyCalendarCommandService;

    await expect(
      command.rescheduleSession({
        externalUserId: 'psid-1',
        userId: 7,
        calendarId: 1,
        schedulingMode: 'explicit',
        newLocalDate: '2099-01-02',
        newTime: '10:00',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(scheduleService.getOutboxSettings).toHaveBeenCalled();
  });

  it('resolves the Messenger-configured sync horizon in the shared calendar client', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const binding = findFactoryProvider(WispaceModule, WispaceCalendarService);
    expect(binding).toBeDefined();

    const values: Record<string, string> = {
      WISPACE_API_USER_CALENDAR_URL:
        'https://backend.example.com/api/UserCalendar',
      WISPACE_INTERNAL_KEY: 'internal-key',
      WISPACE_API_MAX_RETRIES: '0',
      STUDY_REMINDER_SYNC_HORIZON_HOURS: '48',
      CHAT_USAGE_TIMEZONE: 'UTC',
      STUDY_REMINDER_TIMEZONE: 'Asia/Tokyo',
    };
    const configService = new WispaceConfigService((key) => values[key]);
    const appConfigService = {
      get: (key: string) => values[key],
    } as ConfigService;
    const calendarBinding = binding as {
      inject?: unknown[];
      useFactory?: (...args: unknown[]) => unknown;
    };
    expect(calendarBinding.inject).toEqual([
      WispaceConfigService,
      ConfigService,
    ]);
    const calendarService = binding!.useFactory!(
      configService,
      appConfigService,
    ) as WispaceCalendarService;
    global.fetch = jest.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            {
              id: 1,
              userId: 7,
              eventDate: '2026-01-02',
              time: '12:00',
            },
          ]),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    ) as typeof fetch;

    await expect(
      calendarService.getCalendarSessions('psid-1'),
    ).resolves.toEqual([
      expect.objectContaining({
        sessionKey: 'calendar:1',
        scheduledAt: new Date('2026-01-02T12:00:00.000Z'),
      }),
    ]);
  });
});
