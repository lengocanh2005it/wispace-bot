import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WispaceApiClientConfig } from '@wispace/wispace-client';

@Injectable()
export class ZaloWispaceConfigService {
  constructor(private readonly configService: ConfigService) {}

  buildGoalsClientConfig(): WispaceApiClientConfig {
    return this.buildClientConfig(
      'WISPACE_API_USER_GOALS_URL',
      'https://backend.aihubproduction.com/api/User/goals',
    );
  }

  buildTaskScoreClientConfig(): WispaceApiClientConfig {
    return this.buildClientConfig(
      'WISPACE_API_TASK_SCORE_URL',
      'https://backend.aihubproduction.com/api/TaskScoreAverage',
    );
  }

  buildCalendarClientConfig(): WispaceApiClientConfig {
    return this.buildClientConfig('WISPACE_API_USER_CALENDAR_URL');
  }

  getTimezone(): string {
    return (
      this.configService.get<string>('STUDY_REMINDER_TIMEZONE')?.trim() ??
      'Asia/Ho_Chi_Minh'
    );
  }

  private buildClientConfig(
    urlKey: string,
    fallbackUrl?: string,
  ): WispaceApiClientConfig {
    const url = this.configService.get<string>(urlKey)?.trim() ?? fallbackUrl;
    if (!url) {
      throw new InternalServerErrorException(`${urlKey} must be set in .env`);
    }

    return {
      url,
      internalKey: this.getInternalKey(),
      maxRetries: this.readPositiveInt('WISPACE_API_MAX_RETRIES', 3),
      baseDelayMs: this.readPositiveInt('WISPACE_API_RETRY_BASE_DELAY_MS', 500),
    };
  }

  private getInternalKey(): string {
    const key = this.configService.get<string>('WISPACE_INTERNAL_KEY')?.trim();
    if (!key) {
      throw new InternalServerErrorException(
        'WISPACE_INTERNAL_KEY must be set in .env',
      );
    }

    return key;
  }

  private readPositiveInt(key: string, defaultValue: number): number {
    const raw = this.configService.get<string>(key)?.trim();
    if (!raw) return defaultValue;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : defaultValue;
  }
}
