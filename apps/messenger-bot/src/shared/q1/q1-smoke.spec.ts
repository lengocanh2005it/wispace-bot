import { ConfigService } from '@nestjs/config';
import { ChatRateLimitConfigService } from '../../modules/chat-rate-limit/application/services/chat-rate-limit-config.service';
import {
  parseExamDateToIso,
  ReportScheduleService,
  resolveExamCountdown,
  todayReportDate,
} from '@wispace/scheduler-core';
import { resolveAppTimezone } from '../config/app-timezone';

describe('Q1 smoke checks (automated)', () => {
  it('marks a past exam correctly for student reports', () => {
    const currentDate = todayReportDate(
      'Asia/Ho_Chi_Minh',
      new Date('2026-06-14T10:00:00+07:00'),
    );
    const examDate = parseExamDateToIso('10/06/2026');

    expect(resolveExamCountdown(examDate, currentDate)).toEqual({
      daysUntilExam: 0,
      examHasPassed: true,
    });
  });

  it('keeps report cron window aligned with Vietnam calendar dates', () => {
    const config = {
      get: (key: string) =>
        key === 'CHAT_USAGE_TIMEZONE' ? 'Asia/Ho_Chi_Minh' : undefined,
    } as ConfigService;

    const service = new ReportScheduleService(config, {
      getUserGoals: jest.fn(),
      parseExamDate: jest.fn(),
    });

    expect(
      service.calculateDaysUntilExam(
        '2026-06-15',
        new Date('2026-06-13T18:00:00Z'),
      ),
    ).toBe(1);
  });

  it('uses CHAT_USAGE_TIMEZONE as the shared app timezone', () => {
    const config = {
      get: (key: string) =>
        key === 'CHAT_USAGE_TIMEZONE' ? 'Asia/Ho_Chi_Minh' : undefined,
    } as ConfigService;

    expect(resolveAppTimezone(config)).toBe('Asia/Ho_Chi_Minh');
  });

  it('treats CHAT_RATE_LIMIT_ENABLED=true as enforcement on', () => {
    const config = {
      get: (key: string) => {
        const values: Record<string, string> = {
          CHAT_RATE_LIMIT_ENABLED: 'true',
          CHAT_USAGE_TIMEZONE: 'Asia/Ho_Chi_Minh',
          CHAT_FREE_FORM_DAILY_LIMIT: '15',
          CHAT_BURST_PER_MINUTE: '3',
          CHAT_QUOTA_REMAINING_HINT_THRESHOLD: '3',
        };
        return values[key];
      },
    } as ConfigService;

    const settings = new ChatRateLimitConfigService(config).getSettings();

    expect(settings.enabled).toBe(true);
    expect(settings.timezone).toBe('Asia/Ho_Chi_Minh');
  });
});
