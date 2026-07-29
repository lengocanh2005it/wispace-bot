import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readRequiredPositiveNumber } from '@messenger/shared/config/env-helpers';

@Injectable()
export class ReportSendScheduleService {
  constructor(private readonly configService: ConfigService) {}

  getOutboxSettings(): {
    maxRetries: number;
    retryBackoffMinutes: number;
    retryPollCronMinutes: number;
    timezone: string;
  } {
    return {
      maxRetries: readRequiredPositiveNumber(
        this.configService,
        'REPORT_SEND_MAX_RETRIES',
      ),
      retryBackoffMinutes: readRequiredPositiveNumber(
        this.configService,
        'REPORT_SEND_RETRY_BACKOFF_MINUTES',
      ),
      retryPollCronMinutes: readRequiredPositiveNumber(
        this.configService,
        'REPORT_SEND_RETRY_POLL_MINUTES',
      ),
      timezone:
        this.configService.get<string>('CHAT_USAGE_TIMEZONE')?.trim() ||
        'Asia/Ho_Chi_Minh',
    };
  }
}
