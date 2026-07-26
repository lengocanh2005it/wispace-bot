import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class LlmExecutionConfigService {
  constructor(private readonly configService: ConfigService) {}

  isEnabled(): boolean {
    const raw = this.configService
      .get<string>('LLM_EXECUTION_ENABLED')
      ?.trim()
      .toLowerCase();

    if (!raw) {
      return true;
    }

    return raw === 'true' || raw === '1' || raw === 'yes';
  }

  getMaxConcurrent(): number {
    const raw = this.configService.get<string>('LLM_MAX_CONCURRENT')?.trim();

    if (!raw) {
      return 3;
    }

    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      return 3;
    }

    return Math.floor(value);
  }

  getGlobalMaxConcurrent(): number {
    const raw = this.configService
      .get<string>('LLM_GLOBAL_MAX_CONCURRENT')
      ?.trim();

    if (!raw) {
      return 10;
    }

    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      return 10;
    }

    return Math.floor(value);
  }

  getRetryMaxAttempts(): number {
    const raw = this.configService
      .get<string>('LLM_OPENAI_RETRY_MAX_ATTEMPTS')
      ?.trim();

    if (!raw) {
      return 3;
    }

    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      return 3;
    }

    return Math.floor(value);
  }

  getRetryBackoffMs(): number {
    const raw = this.configService
      .get<string>('LLM_OPENAI_RETRY_BACKOFF_MS')
      ?.trim();

    if (!raw) {
      return 2_000;
    }

    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      return 2_000;
    }

    return Math.floor(value);
  }

  getRequestTimeoutMs(): number {
    const raw = this.configService
      .get<string>('LLM_REQUEST_TIMEOUT_MS')
      ?.trim();

    if (!raw) {
      return 30_000;
    }

    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      return 30_000;
    }

    return Math.floor(value);
  }

  // --- LLM provider config (used by OpenAiAdapter) ---

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

  // --- Failover config ---

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

  getOpenRouterApiKey(): string | undefined {
    return (
      this.configService.get<string>('OPENROUTER_API_KEY')?.trim() || undefined
    );
  }

  getOpenRouterModel(): string {
    return (
      this.configService.get<string>('OPENROUTER_MODEL')?.trim() ||
      'openai/gpt-4o-mini'
    );
  }

  getOpenRouterBaseUrl(): string | undefined {
    return (
      this.configService.get<string>('OPENROUTER_BASE_URL')?.trim() ||
      'https://openrouter.ai/api/v1'
    );
  }

  getMiniMaxApiKey(): string | undefined {
    return (
      this.configService.get<string>('MINIMAX_API_KEY')?.trim() || undefined
    );
  }

  getMiniMaxModel(): string {
    return (
      this.configService.get<string>('MINIMAX_MODEL')?.trim() ||
      'MiniMax-Text-01'
    );
  }

  getMiniMaxBaseUrl(): string | undefined {
    return (
      this.configService.get<string>('MINIMAX_BASE_URL')?.trim() ||
      'https://api.minimax.chat/v1'
    );
  }

  getFailoverCooldownLongMs(): number {
    return this.getPositiveNumber('LLM_FAILOVER_COOLDOWN_LONG_MS', 600_000);
  }

  getFailoverCooldownShortMs(): number {
    return this.getPositiveNumber('LLM_FAILOVER_COOLDOWN_SHORT_MS', 5_000);
  }

  getFailoverQuickRetryDelayMs(): number {
    return this.getPositiveNumber('LLM_FAILOVER_QUICK_RETRY_DELAY_MS', 150);
  }

  private getPositiveNumber(envKey: string, defaultValue: number): number {
    const raw = this.configService.get<string>(envKey)?.trim();
    if (!raw) return defaultValue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return defaultValue;
    return Math.floor(value);
  }
}
