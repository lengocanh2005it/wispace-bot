import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import { runLockedTick } from '@wispace/bot-common/cron';
import { readEnvBoolean, readEnvPositiveInt } from '@wispace/bot-common/config';
import {
  RETENTION_CLEANUP_METRICS_PORT,
  type RetentionCleanupMetricsPort,
} from '@wispace/bot-common/metrics';
import { subDays } from 'date-fns';
import {
  createCleanupCronPolicyRegistry,
  type CleanupCronPolicy,
  type CleanupCronPolicyRegistry,
} from './cleanup-policy.registry';

export interface CleanupResult {
  deleted: number;
  cutoff?: Date;
}

/**
 * Generic cleanup cron service for deleting old records from any table.
 * Uses the registered policy and a PostgreSQL advisory lock for multi-pod safety.
 */
@Injectable()
export class CleanupCronService {
  private readonly logger = new Logger(CleanupCronService.name);
  private readonly policies: CleanupCronPolicyRegistry;

  constructor(
    private readonly configService: ConfigService,
    private readonly pgLock: PgAdvisoryLockService,
    @Optional() policyRegistry?: CleanupCronPolicyRegistry,
    @Optional()
    @Inject(RETENTION_CLEANUP_METRICS_PORT)
    private readonly retentionMetrics?: RetentionCleanupMetricsPort,
  ) {
    this.policies = policyRegistry ?? createCleanupCronPolicyRegistry();
  }

  /**
   * Execute cleanup with advisory lock protection.
   * @param name - Registered cleanup policy name
   * @param advisoryLockId - Advisory lock ID for multi-pod safety
   * @param deleteFn - Function that deletes records older than cutoff, returns count
   */
  async execute(
    name: string,
    advisoryLockId: number,
    deleteFn: (cutoff?: Date) => Promise<number>,
  ): Promise<CleanupResult | null> {
    const policy = this.policies.resolve(name);
    this.recordMetric(() => this.retentionMetrics?.registerPolicy(name));
    const enabled = this.isEnabled(name);
    const retentionDays = this.getRetentionDays(name);
    const cutoff = policy.retention
      ? subDays(new Date(), retentionDays)
      : undefined;

    const result = await runLockedTick<{ deleted: number }>({
      name,
      enabled,
      withLock: (run) => this.pgLock.withLock(advisoryLockId, run),
      run: async () => {
        try {
          const deleted = await deleteFn(cutoff);
          if (deleted > 0) {
            this.logger.log(
              `${name}: deleted ${deleted} row(s)${
                cutoff
                  ? ` older than ${retentionDays} day(s) (before ${cutoff.toISOString()})`
                  : ''
              }`,
            );
            this.recordMetric(() =>
              this.retentionMetrics?.incRowsDeleted(name, deleted),
            );
          }
          return [{ outcome: 'succeeded' as const, details: { deleted } }];
        } catch (error) {
          this.recordMetric(() => this.retentionMetrics?.incCleanupError(name));
          throw error;
        }
      },
      logger: this.logger,
    });

    if (result === null) return null;
    return { deleted: result.details[0]?.deleted ?? 0, cutoff };
  }

  isEnabled(name: string): boolean {
    return this.readEnabled(this.policies.resolve(name));
  }

  getRetentionDays(name: string): number {
    return this.readRetentionDays(this.policies.resolve(name));
  }

  /** Metrics must never change cleanup behavior when an adapter is unavailable. */
  private recordMetric(record: () => void): void {
    try {
      record();
    } catch (error) {
      this.logger.warn(
        `Could not record retention cleanup metric: ${String(error)}`,
      );
    }
  }

  private readEnabled(policy: CleanupCronPolicy): boolean {
    const keys = [
      policy.enabledConfigKey,
      policy.enabledFallbackConfigKey,
    ].filter((key): key is string => Boolean(key));
    for (const key of keys) {
      const raw = this.configService.get<string>(key)?.trim();
      if (raw)
        return readEnvBoolean(this.configService, key, policy.defaultEnabled);
    }
    return policy.defaultEnabled;
  }

  private readRetentionDays(policy: CleanupCronPolicy): number {
    const defaultDays = policy.retention?.defaultDays ?? 0;
    const key = policy.retention?.configKey;
    if (!key) return defaultDays;

    return readEnvPositiveInt(this.configService, key, defaultDays);
  }
}
