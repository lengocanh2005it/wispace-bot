import { ConfigService } from '@nestjs/config';

import { ReportSendScheduleService } from './report-send-schedule.service';

describe('ReportSendScheduleService', () => {
  it('keeps job and claim leases separate', () => {
    const config = {
      get: jest.fn(
        (key: string) =>
          ({
            REPORT_SEND_LEASE_MS: '600000',
            REPORT_CLAIM_STALE_RESET_MS: '7200000',
            CHAT_USAGE_TIMEZONE: 'UTC',
          })[key],
      ),
    } as unknown as ConfigService;

    const settings = new ReportSendScheduleService(config).getOutboxSettings();

    expect(settings.leaseMs).toBe(600_000);
    expect(settings.claimLeaseMs).toBe(7_200_000);
  });

  it('preserves the two-hour claim lease default', () => {
    const config = {
      get: jest.fn(() => undefined),
    } as unknown as ConfigService;

    expect(
      new ReportSendScheduleService(config).getOutboxSettings().claimLeaseMs,
    ).toBe(2 * 60 * 60 * 1000);
  });

  it('falls back when a lease setting is not a positive number', () => {
    const config = {
      get: jest.fn(
        (key: string) =>
          ({
            REPORT_SEND_LEASE_MS: '0',
            REPORT_CLAIM_STALE_RESET_MS: 'invalid',
          })[key],
      ),
    } as unknown as ConfigService;

    const settings = new ReportSendScheduleService(config).getOutboxSettings();

    expect(settings.leaseMs).toBe(600_000);
    expect(settings.claimLeaseMs).toBe(2 * 60 * 60 * 1000);
  });

  it('preserves integer-millisecond claim lease parsing', () => {
    const config = {
      get: jest.fn((key: string) =>
        key === 'REPORT_CLAIM_STALE_RESET_MS' ? '7200000.9' : undefined,
      ),
    } as unknown as ConfigService;

    expect(
      new ReportSendScheduleService(config).getOutboxSettings().claimLeaseMs,
    ).toBe(7_200_000);
  });
});
