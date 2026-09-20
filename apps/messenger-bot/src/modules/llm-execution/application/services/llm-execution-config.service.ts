import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  readEnvBoolean,
  readEnvPositiveInt,
} from '@messenger/shared/config/env-helpers';
import { readMaxTotalProviderAttempts } from '@wispace/llm-agent/core';

@Injectable()
export class LlmExecutionConfigService {
  constructor(private readonly configService: ConfigService) {
    // Validate the new bounded generation cap during module construction so
    // an invalid explicit value fails closed at startup, not on first traffic.
    this.getMaxTotalProviderAttempts();
  }

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
      1,
    );
  }

  getMaxTotalProviderAttempts(): number {
    return readMaxTotalProviderAttempts(
      this.configService.get<string>('LLM_MAX_TOTAL_PROVIDER_ATTEMPTS'),
    );
  }

  getRetryBackoffMs(): number {
    return readEnvPositiveInt(
      this.configService,
      'LLM_OPENAI_RETRY_BACKOFF_MS',
      2_000,
    );
  }

  getRetryMaxDelayMs(): number {
    return readEnvPositiveInt(
      this.configService,
      'LLM_OPENAI_RETRY_MAX_DELAY_MS',
      10_000,
    );
  }

  getRequestTimeoutMs(): number {
    return readEnvPositiveInt(
      this.configService,
      'LLM_REQUEST_TIMEOUT_MS',
      30_000,
    );
  }

  getPerAttemptTimeoutMs(): number {
    return readEnvPositiveInt(
      this.configService,
      'LLM_RETRY_PER_ATTEMPT_TIMEOUT_MS',
      10_000,
    );
  }

  getApiKey(): string | undefined {
    return this.getAliasedValue('LLM_API_KEY', 'OPENAI_API_KEY');
  }

  getModel(): string | undefined {
    return this.getAliasedValue('LLM_MODEL', 'OPENAI_MODEL');
  }

  getBaseUrl(): string | undefined {
    return this.getAliasedValue('LLM_BASE_URL', 'OPENAI_BASE_URL');
  }

  getProvider(): string | undefined {
    return this.configService.get<string>('LLM_PROVIDER')?.trim() || undefined;
  }

  /** Fail closed instead of relying on precedence when aliases disagree. */
  assertAliasConsistency(): void {
    this.getAliasedValue('LLM_API_KEY', 'OPENAI_API_KEY');
    this.getAliasedValue('LLM_MODEL', 'OPENAI_MODEL');
    this.getAliasedValue('LLM_BASE_URL', 'OPENAI_BASE_URL');
  }

  private getAliasedValue(
    aliasKey: string,
    canonicalKey: string,
  ): string | undefined {
    const alias = this.configService.get<string>(aliasKey)?.trim() || undefined;
    const canonical =
      this.configService.get<string>(canonicalKey)?.trim() || undefined;
    if (alias && canonical && alias !== canonical) {
      throw new Error(
        `LLM configuration conflict: ${aliasKey} and ${canonicalKey} must agree`,
      );
    }
    return alias ?? canonical;
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
