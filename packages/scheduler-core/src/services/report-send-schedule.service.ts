import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ReportSendScheduleService {
  constructor(private readonly configService: ConfigService) {}

  getOutboxSettings(): {
    maxRetries: number;
    retryBackoffMinutes: number;
    retryPollCronMinutes: number;
    leaseMs: number;
    timezone: string;
  } {
    return {
      maxRetries: this.getPositiveNumber('REPORT_SEND_MAX_RETRIES', 3),
      retryBackoffMinutes: this.getPositiveNumber(
        'REPORT_SEND_RETRY_BACKOFF_MINUTES',
        15,
      ),
      retryPollCronMinutes: this.getPositiveNumber(
        'REPORT_SEND_RETRY_POLL_MINUTES',
        15,
      ),
      leaseMs: this.getPositiveNumber('REPORT_SEND_LEASE_MS', 600_000),
      timezone:
        this.configService.get<string>('CHAT_USAGE_TIMEZONE')?.trim() ||
        'Asia/Ho_Chi_Minh',
    };
  }

  private getPositiveNumber(key: string, defaultValue: number): number {
    const raw = this.configService.get<string>(key)?.trim();
    if (!raw) return defaultValue;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : defaultValue;
  }
}
