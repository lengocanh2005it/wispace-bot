import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { todayInTimezone as todayUsageDate } from '@wispace/date-utils';
import {
  buildInputCostEnvKey,
  buildOutputCostEnvKey,
  buildCachedInputCostEnvKey,
  buildProviderInputCostEnvKey,
  buildProviderOutputCostEnvKey,
  buildProviderCachedInputCostEnvKey,
  estimateCostUsd,
} from './cost.utils';

/**
 * LLM usage tracking config — shared by Discord and Zalo (identical classes,
 * now consolidated into one).
 */
@Injectable()
export class LlmUsageConfigService {
  constructor(private readonly configService: ConfigService) {}

  isEnabled(): boolean {
    const raw = this.configService
      .get<string>('LLM_USAGE_ENABLED')
      ?.trim()
      .toLowerCase();

    return raw !== 'false' && raw !== '0';
  }

  todayUsageDate(): string {
    const timezone =
      this.configService.get<string>('LLM_USAGE_TIMEZONE')?.trim() ||
      'Asia/Ho_Chi_Minh';
    return todayUsageDate(timezone);
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
    const inputRaw = inputKey
      ? this.configService.get<string>(inputKey)
      : undefined;
    const outputRaw = outputKey
      ? this.configService.get<string>(outputKey)
      : undefined;
    const cachedInputRaw = cachedInputKey
      ? this.configService.get<string>(cachedInputKey)
      : undefined;

    const inputUsdPer1M = inputRaw ? Number(inputRaw) : null;
    const outputUsdPer1M = outputRaw ? Number(outputRaw) : null;
    const cachedInputUsdPer1M = cachedInputRaw ? Number(cachedInputRaw) : null;

    return estimateCostUsd(
      promptTokens,
      completionTokens,
      Number.isFinite(inputUsdPer1M) ? inputUsdPer1M : null,
      Number.isFinite(outputUsdPer1M) ? outputUsdPer1M : null,
      cachedTokens,
      Number.isFinite(cachedInputUsdPer1M) ? cachedInputUsdPer1M : null,
    );
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
