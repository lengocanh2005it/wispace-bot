import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RETENTION_CLEANUP_METRICS_PORT } from '@wispace/bot-common/metrics';
import type { RetentionCleanupMetricsPort } from '@wispace/bot-common/metrics';
import {
  LlmUsageEventEntity,
  LlmUsageRepository as ChatMeteringLlmUsageRepository,
} from '@wispace/chat-metering/adapters';
import type { LlmUsageRepositoryPort } from '../../domain/repositories/llm-usage.repository.port';
import type { RecordLlmUsageInput } from '../../domain/entities/llm-usage.types';
import type {
  LlmUsageAggregateRow,
  LlmUsageQueryFilter,
} from '../../domain/entities/llm-usage-summary.types';

/** This repository only ever writes rows for the Messenger bot. */
const PLATFORM = 'messenger' as const;

@Injectable()
export class LlmUsageRepository implements LlmUsageRepositoryPort {
  private readonly core: ChatMeteringLlmUsageRepository;

  constructor(
    @InjectRepository(LlmUsageEventEntity)
    usageRepo: Repository<LlmUsageEventEntity>,
    @Optional()
    @Inject(RETENTION_CLEANUP_METRICS_PORT)
    private readonly metrics?: RetentionCleanupMetricsPort,
  ) {
    this.core = new ChatMeteringLlmUsageRepository(usageRepo, PLATFORM);
  }

  insertUsage(
    input: RecordLlmUsageInput & { usageDate: string },
  ): Promise<void> {
    return this.core.insertUsage({ ...input, externalUserId: input.psid });
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const deleted = await this.core.deleteOlderThan(cutoff);
    if (deleted > 0) {
      try {
        this.metrics?.incLlmUsageDeleted(deleted);
      } catch {
        // Metrics must not turn a successful retention delete into a failure.
      }
    }
    return deleted;
  }

  aggregateUsage(filter: LlmUsageQueryFilter): Promise<LlmUsageAggregateRow[]> {
    return this.core.aggregateUsage({
      externalUserId: filter.psid,
      userId: filter.userId,
      fromDate: filter.fromDate,
      toDate: filter.toDate,
    });
  }

  aggregateFleetByDate(usageDate: string): Promise<LlmUsageAggregateRow[]> {
    return this.core.aggregateFleetByDate(usageDate);
  }
}
