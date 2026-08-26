import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  readEnvBoolean,
  readEnvPositiveInt,
} from '@messenger/shared/config/env-helpers';

@Injectable()
export class LlmExecutionConfigService {
  constructor(private readonly configService: ConfigService) {}

  isEnabled(): boolean {
    return readEnvBoolean(this.configService, 'LLM_EXECUTION_ENABLED', true);
  }

  getMaxConcurrent(): number {
    return readEnvPositiveInt(this.configService, 'LLM_MAX_CONCURRENT', 3);
  }

  getMaxQueueDepth(): number {
    return readEnvPositiveInt(this.configService, 'LLM_MAX_QUEUE_DEPTH', 50);
  }

  getChatAdmissionWaitMs(): number {
    return readEnvPositiveInt(
      this.configService,
      'LLM_ADMISSION_WAIT_MS',
      8_000,
    );
  }

  getBackgroundAdmissionWaitMs(): number {
    return readEnvPositiveInt(
      this.configService,
      'LLM_BACKGROUND_ADMISSION_WAIT_MS',
      1_500,
    );
  }

  isGlobalConcurrencyEnabled(): boolean {
    return readEnvBoolean(
      this.configService,
      'LLM_GLOBAL_CONCURRENCY_ENABLED',
      false,
    );
  }

  getGlobalMaxConcurrent(): number {
    return readEnvPositiveInt(
      this.configService,
      'LLM_GLOBAL_MAX_CONCURRENT',
      10,
    );
  }

  getRetryMaxAttempts(): number {
    return readEnvPositiveInt(
      this.configService,
      'LLM_OPENAI_RETRY_MAX_ATTEMPTS',
      3,
    );
  }

  getRetryBackoffMs(): number {
    return readEnvPositiveInt(
      this.configService,
      'LLM_OPENAI_RETRY_BACKOFF_MS',
      2_000,
    );
  }

  getRequestTimeoutMs(): number {
    return readEnvPositiveInt(
      this.configService,
      'LLM_REQUEST_TIMEOUT_MS',
      30_000,
    );
  }

  getApiKey(): string | undefined {
    return (
      this.configService.get<string>('LLM_API_KEY')?.trim() ||
      this.configService.get<string>('OPENAI_API_KEY')?.trim() ||
      undefined
    );
  }

  getModel(): string {
    return (
      this.configService.get<string>('LLM_MODEL')?.trim() ||
      this.configService.get<string>('OPENAI_MODEL')?.trim() ||
      'gpt-5.4'
    );
  }

  getBaseUrl(): string | undefined {
    return this.configService.get<string>('LLM_BASE_URL')?.trim() || undefined;
  }

  getProvider(): string | undefined {
    return this.configService.get<string>('LLM_PROVIDER')?.trim() || undefined;
  }

  getFailoverOrder(): string[] {
    const raw = this.configService
      .get<string>('LLM_PROVIDER_FAILOVER_ORDER')
      ?.trim();
    if (!raw) return [];
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  getFailoverCooldownLongMs(): number {
    return readEnvPositiveInt(
      this.configService,
      'LLM_FAILOVER_COOLDOWN_LONG_MS',
      600_000,
    );
  }

  getFailoverCooldownShortMs(): number {
    return readEnvPositiveInt(
      this.configService,
      'LLM_FAILOVER_COOLDOWN_SHORT_MS',
      5_000,
    );
  }

  getFailoverQuickRetryDelayMs(): number {
    return readEnvPositiveInt(
      this.configService,
      'LLM_FAILOVER_QUICK_RETRY_DELAY_MS',
      150,
    );
  }
}
