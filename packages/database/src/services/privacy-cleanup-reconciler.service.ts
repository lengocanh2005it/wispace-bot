import { Cron } from '@nestjs/schedule';
import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { Platform } from '@wispace/contracts';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import { errorMessage } from '@wispace/bot-common/masking';
import {
  PrivacyCleanupJobStore,
  PRIVACY_CLEANUP_WORKER_BATCH_SIZE,
  PRIVACY_CLEANUP_WORKER_LEASE_MS,
  type PrivacyCleanupMetrics,
  type PrivacyCleanupStore,
} from './privacy-cleanup-job.service';
import {
  hasPrivacyCleanupAdapter,
  isPrivacyCleanupGenerationCurrent,
  privacyCleanupCallbackForStore,
  type PrivacyStateCleanup,
} from './privacy-data.service';

export interface PrivacyCleanupReconcilerOptions {
  lockId?: number;
  pgLock?: PgAdvisoryLockService;
  metrics?: PrivacyCleanupMetrics;
  store?: PrivacyCleanupJobStore;
}

export interface PrivacyCleanupRunResult {
  claimed: number;
  completed: number;
  failed: number;
  stale: number;
}

/** Own-platform five-minute recovery worker for durable privacy state jobs. */
export class PrivacyCleanupReconciler {
  private readonly logger = new Logger(PrivacyCleanupReconciler.name);
  private readonly jobs: PrivacyCleanupJobStore;

  constructor(
    private readonly dataSource: DataSource,
    private readonly platform: Platform,
    private readonly cleanup: PrivacyStateCleanup,
    private readonly options: PrivacyCleanupReconcilerOptions = {},
  ) {
    if (cleanup.platform && cleanup.platform !== platform) {
      throw new Error(
        `Privacy cleanup reconciler is configured for ${cleanup.platform}, not ${platform}`,
      );
    }
    const stores =
      cleanup.applicableStores ??
      (platform === 'messenger'
        ? [
            'chat_history',
            'chat_queue',
            'clarification_state',
            'display_name_cache',
          ]
        : ['chat_history', 'chat_queue', 'clarification_state']);
    for (const store of stores as PrivacyCleanupStore[]) {
      if (!hasPrivacyCleanupAdapter(cleanup, store)) {
        throw new Error(
          `Privacy cleanup adapter missing for configured store: ${store}`,
        );
      }
    }
    this.jobs = options.store ?? new PrivacyCleanupJobStore(dataSource);
  }

  @Cron('*/5 * * * *')
  async tick(): Promise<PrivacyCleanupRunResult | null> {
    const lockId = this.options.lockId;
    if (this.options.pgLock && lockId) {
      return this.options.pgLock.withLock(lockId, () => this.process());
    }
    return this.process();
  }

  async runOnce(): Promise<PrivacyCleanupRunResult> {
    return this.process();
  }

  private async process(): Promise<PrivacyCleanupRunResult> {
    const jobs = await this.jobs.claimDue(
      this.platform,
      PRIVACY_CLEANUP_WORKER_BATCH_SIZE,
      PRIVACY_CLEANUP_WORKER_LEASE_MS,
    );
    const result: PrivacyCleanupRunResult = {
      claimed: jobs.length,
      completed: 0,
      failed: 0,
      stale: 0,
    };

    for (const job of jobs) {
      try {
        if (job.store === 'display_name_cache' && job.userId === undefined) {
          await this.jobs.markStale(job, job.leaseToken);
          this.options.metrics?.incPrivacyCleanupAttempt(
            this.platform,
            job.operation,
            job.store,
            'stale',
          );
          result.stale += 1;
          continue;
        }
        const action = privacyCleanupCallbackForStore(
          this.cleanup,
          job.store,
          job.externalUserId,
          job.userId,
        );
        if (!action) {
          throw new Error(`Privacy cleanup adapter missing for ${job.store}`);
        }
        // The mapping can change after the initial fence check while a worker
        // is resolving its adapter. Fence again immediately before touching
        // the platform-owned state store.
        if (
          !(await isPrivacyCleanupGenerationCurrent(
            this.dataSource,
            this.platform,
            job.externalUserId,
            job.mappingGeneration,
          ))
        ) {
          await this.jobs.markStale(job, job.leaseToken);
          this.options.metrics?.incPrivacyCleanupAttempt(
            this.platform,
            job.operation,
            job.store,
            'stale',
          );
          result.stale += 1;
          continue;
        }
        await action();
        await this.jobs.markCompleted(job, job.leaseToken);
        this.options.metrics?.incPrivacyCleanupAttempt(
          this.platform,
          job.operation,
          job.store,
          'success',
        );
        result.completed += 1;
      } catch (error) {
        try {
          await this.jobs.markFailure(
            job,
            errorMessage(error, {
              externalUserId: job.externalUserId,
              maxChars: 160,
            }),
            job.leaseToken,
          );
        } catch (persistError) {
          this.logger.warn(
            `Privacy cleanup retry state unavailable platform=${this.platform} store=${job.store}: ${errorMessage(persistError, { externalUserId: job.externalUserId, maxChars: 120 })}`,
          );
        }
        this.options.metrics?.incPrivacyCleanupAttempt(
          this.platform,
          job.operation,
          job.store,
          'failure',
        );
        result.failed += 1;
        this.logger.warn(
          `Privacy cleanup retry scheduled platform=${this.platform} store=${job.store}`,
        );
      }
    }

    await this.jobs.pruneRetention();
    try {
      const summary = await this.jobs.getSummary(this.platform);
      this.options.metrics?.setPrivacyCleanupPending(
        this.platform,
        summary.pendingCount + summary.processingCount,
        summary.oldestPendingAgeSeconds,
      );
    } catch (error) {
      this.logger.warn(
        `Privacy cleanup summary unavailable platform=${this.platform}: ${errorMessage(error, { maxChars: 120 })}`,
      );
    }
    return result;
  }
}
