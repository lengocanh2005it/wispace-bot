import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildInputCostEnvKey,
  buildOutputCostEnvKey,
  buildCachedInputCostEnvKey,
  estimateCostUsd,
  todayUsageDate,
} from '@wispace/chat-metering';
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
  ): string | null {
    return estimateCostUsd(
      promptTokens,
      completionTokens,
      this.getModelInputUsdPer1M(model),
      this.getModelOutputUsdPer1M(model),
      cachedTokens,
      this.getModelCachedInputUsdPer1M(model),
    );
  }

  getCostDisclaimer(): string {
    return 'Estimated from env LLM_COST_USD_PER_1M_* pricing; not an OpenAI invoice.';
  }

  private readPositiveNumber(envKey: string): number | null {
    const raw = this.configService.get<string>(envKey)?.trim();
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return null;
    return value;
  }
}
