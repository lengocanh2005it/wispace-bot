import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildInputCostEnvKey,
  buildOutputCostEnvKey,
  buildCachedInputCostEnvKey,
  buildProviderInputCostEnvKey,
  buildProviderOutputCostEnvKey,
  buildProviderCachedInputCostEnvKey,
  estimateCostUsd,
  todayUsageDate,
} from '@wispace/chat-metering/core';
import {
  readEnvBoolean,
  readEnvPositiveInt,
} from '@messenger/shared/config/env-helpers';
import { resolveAppTimezone } from '@messenger/shared/config/app-timezone';

@Injectable()
export class LlmUsageConfigService {
  constructor(private readonly configService: ConfigService) {}

  isEnabled(): boolean {
    return readEnvBoolean(this.configService, 'LLM_USAGE_ENABLED', true);
  }

  getTimezone(): string {
    return resolveAppTimezone(this.configService);
  }

  getRetentionDays(): number {
    return readEnvPositiveInt(
      this.configService,
      'LLM_USAGE_RETENTION_DAYS',
      180,
    );
  }

  todayUsageDate(now = new Date()): string {
    return todayUsageDate(this.getTimezone(), now);
  }

  getModelInputUsdPer1M(model: string): number | null {
    return this.readPositiveNumber(buildInputCostEnvKey(model));
  }

  getModelOutputUsdPer1M(model: string): number | null {
    return this.readPositiveNumber(buildOutputCostEnvKey(model));
  }

  getModelCachedInputUsdPer1M(model: string): number | null {
    return this.readPositiveNumber(buildCachedInputCostEnvKey(model));
  }

  estimateCostUsdForModel(
    model: string,
    promptTokens: number,
    completionTokens: number,
    cachedTokens = 0,
    provider?: string,
  ): string | null {
    const providerPricing = this.hasFailoverChain();
    const normalizedProvider = provider?.trim();
    const inputKey = providerPricing
      ? normalizedProvider
        ? buildProviderInputCostEnvKey(normalizedProvider, model)
        : undefined
      : buildInputCostEnvKey(model);
    const outputKey = providerPricing
      ? normalizedProvider
        ? buildProviderOutputCostEnvKey(normalizedProvider, model)
        : undefined
      : buildOutputCostEnvKey(model);
    const cachedInputKey = providerPricing
      ? normalizedProvider
        ? buildProviderCachedInputCostEnvKey(normalizedProvider, model)
        : undefined
      : buildCachedInputCostEnvKey(model);
    return estimateCostUsd(
      promptTokens,
      completionTokens,
      this.readPositiveNumber(inputKey),
      this.readPositiveNumber(outputKey),
      cachedTokens,
      this.readPositiveNumber(cachedInputKey),
    );
  }

  getCostDisclaimer(): string {
    return 'Estimated from env LLM_COST_USD_PER_1M_* pricing; not an OpenAI invoice.';
  }

  private readPositiveNumber(envKey?: string): number | null {
    if (!envKey) return null;
    const raw = this.configService.get<string>(envKey)?.trim();
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return null;
    return value;
  }

  private hasFailoverChain(): boolean {
    return (
      (this.configService.get<string>('LLM_PROVIDER_FAILOVER_ORDER') ?? '')
        .split(',')
        .map((provider) => provider.trim())
        .filter(Boolean).length > 1
    );
  }
}
