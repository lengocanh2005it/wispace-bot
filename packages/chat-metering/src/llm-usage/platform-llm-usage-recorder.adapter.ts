import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { errorMessage } from '@wispace/bot-common';
import { LlmUsageEventEntity } from '../entities';
import { DirectUsageWriter } from './direct-usage-writer';
import { LlmUsageRecorderCore } from './llm-usage-recorder-core.service';
import { LlmUsageRepository } from './llm-usage.repository';

/** Config surface the adapter needs — satisfied by each app's `LlmUsageConfigService`. */
export interface PlatformLlmUsageConfig {
  isEnabled(): boolean;
  estimateCostUsdForModel(
    model: string,
    promptTokens: number,
    completionTokens: number,
    cachedTokens?: number,
  ): string | null;
  todayUsageDate(): string;
}

/** Per-app adapter input — `externalUserId` replaces the app-specific `discordUserId`/`zaloUserId`. */
export interface PlatformRecordLlmUsageInput {
  feature: string;
  externalUserId: string;
  userId?: number;
  model: string;
  response: { id: string; usage?: unknown };
  correlationId?: string;
  toolRound?: number;
}

/**
 * Thin NestJS adapter around `LlmUsageRecorderCore` — shared by Discord and
 * Zalo (replaces their near-identical per-app recorders). Platform
 * (`'discord'` / `'zalo'`) parameterizes the persisted event row. MVP:
 * direct fire-and-forget insert (no BullMQ queue/retry yet).
 */
@Injectable()
export class PlatformLlmUsageRecorderAdapter {
  private readonly logger = new Logger(PlatformLlmUsageRecorderAdapter.name);
  private core?: LlmUsageRecorderCore;

  constructor(
    private readonly platform: string,
    private readonly config: PlatformLlmUsageConfig,
    @InjectRepository(LlmUsageEventEntity)
    private readonly usageRepo: Repository<LlmUsageEventEntity>,
  ) {}

  recordFromCompletion(input: PlatformRecordLlmUsageInput): void {
    if (!this.config.isEnabled()) {
      return;
    }

    this.getCore().recordFromCompletion({
      feature: input.feature,
      externalUserId: input.externalUserId,
      userId: input.userId,
      model: input.model,
      response: input.response,
      correlationId: input.correlationId,
      toolRound: input.toolRound,
    });
  }

  private getCore(): LlmUsageRecorderCore {
    if (!this.core) {
      const repository = new LlmUsageRepository(this.usageRepo, this.platform);
      const writer = new DirectUsageWriter(repository, (error) => {
        this.logger.warn(`LLM_USAGE_INSERT_FAILED: ${errorMessage(error)}`);
      });

      this.core = new LlmUsageRecorderCore(
        writer,
        (model, promptTokens, completionTokens, cachedTokens) =>
          this.config.estimateCostUsdForModel(
            model,
            promptTokens,
            completionTokens,
            cachedTokens,
          ),
        () => this.config.todayUsageDate(),
        { warn: (m) => this.logger.warn(m) },
      );
    }

    return this.core;
  }
}
