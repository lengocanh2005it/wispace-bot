import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type Provider,
  type Type,
} from '@nestjs/common';
import { InjectRepository, getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { errorMessage } from '@wispace/bot-common/masking';
import type { LlmUsage } from '@wispace/llm-agent';
import { LlmUsageEventEntity } from '../entities';
import { DirectUsageWriter } from './direct-usage-writer';
import {
  LlmUsageRecorderCore,
  toUsageRecorderMetrics,
  type BotMetricsUsageRecorderSource,
  type LlmUsageRecorderMetrics,
} from './llm-usage-recorder-core.service';
import { LlmUsageConfigService } from './llm-usage-config.service';
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
  provider?: string;
  model: string;
  response: { id: string; usage?: LlmUsage | null };
  correlationId?: string;
  toolRound?: number;
  /** #549 — marks a zero-token failure row; the class enum, never raw text. */
  status?: 'ok' | 'error';
  errorMessage?: string;
}

/**
 * Thin NestJS adapter around `LlmUsageRecorderCore` — shared by Discord and
 * Zalo (replaces their near-identical per-app recorders). Platform
 * (`'discord'` / `'zalo'`) parameterizes the persisted event row. MVP:
 * direct fire-and-forget insert (no BullMQ queue/retry yet).
 */
@Injectable()
export class PlatformLlmUsageRecorderAdapter implements OnModuleDestroy {
  private readonly logger = new Logger(PlatformLlmUsageRecorderAdapter.name);
  private core?: LlmUsageRecorderCore;

  constructor(
    private readonly platform: string,
    private readonly config: PlatformLlmUsageConfig,
    @InjectRepository(LlmUsageEventEntity)
    private readonly usageRepo: Repository<LlmUsageEventEntity>,
    private readonly metrics?: LlmUsageRecorderMetrics,
  ) {}

  recordFromCompletion(input: PlatformRecordLlmUsageInput): void {
    if (!this.config.isEnabled()) {
      return;
    }

    this.getCore().recordFromCompletion({
      feature: input.feature,
      externalUserId: input.externalUserId,
      userId: input.userId,
      provider: input.provider,
      model: input.model,
      response: input.response,
      correlationId: input.correlationId,
      toolRound: input.toolRound,
      status: input.status,
      errorMessage: input.errorMessage,
    });
  }

  private getCore(): LlmUsageRecorderCore {
    if (!this.core) {
      const repository = new LlmUsageRepository(this.usageRepo, this.platform);
      const writer = new DirectUsageWriter(repository, (error) => {
        this.logger.warn(`LLM_USAGE_INSERT_FAILED: ${errorMessage(error)}`);
        this.metrics?.incInsertFailure('db_error');
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
        this.metrics,
      );
    }

    return this.core;
  }

  onModuleDestroy(): void {
    this.core?.dispose();
  }
}

/**
 * #549 — app-side override that shadows `ChatMeteringModule.forPlatform`'s
 * unwired recorder with one carrying the app metrics service, so the
 * missing-tokens/unpriced-model/insert-failure counters stop being no-ops.
 * The metrics token is supplied by the app (its own metrics service class)
 * — this package never imports `@wispace/bot-metrics`, keeping the
 * dependency direction app → shared. Within the importing module the local
 * registration wins over the imported one.
 */
export function provideWiredUsageRecorder(
  platform: string,
  metricsToken: Type<unknown> | string | symbol,
): Provider {
  return {
    provide: PlatformLlmUsageRecorderAdapter,
    useFactory: (
      configService: ConfigService,
      usageRepo: Repository<LlmUsageEventEntity>,
      metrics?: BotMetricsUsageRecorderSource,
    ) =>
      new PlatformLlmUsageRecorderAdapter(
        platform,
        new LlmUsageConfigService(configService),
        usageRepo,
        metrics ? toUsageRecorderMetrics(metrics) : undefined,
      ),
    inject: [
      ConfigService,
      getRepositoryToken(LlmUsageEventEntity),
      { token: metricsToken, optional: true },
    ],
  };
}
