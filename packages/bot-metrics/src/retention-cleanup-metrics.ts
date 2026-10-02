import { Counter, type Registry } from 'prom-client';
import type { RetentionCleanupMetricsPort } from '@wispace/bot-common/metrics';

/** Retention counters registered in the owning bot's Prometheus registry. */
export class RetentionCleanupMetrics implements RetentionCleanupMetricsPort {
  private readonly rowsDeleted: Counter<string>;
  private readonly cleanupErrors: Counter<string>;
  private readonly llmUsageDeleted: Counter;

  constructor(prefix: string, registry: Registry) {
    this.rowsDeleted = new Counter({
      name: `${prefix}_retention_rows_deleted_total`,
      help: 'Total rows deleted by retention cleanup crons',
      labelNames: ['cron_name'],
      registers: [registry],
    });
    this.cleanupErrors = new Counter({
      name: `${prefix}_retention_cleanup_errors_total`,
      help: 'Total retention cleanup failures',
      labelNames: ['cron_name'],
      registers: [registry],
    });
    this.llmUsageDeleted = new Counter({
      name: `${prefix}_llm_usage_retention_deleted_total`,
      help: 'Total rows deleted by LLM usage retention cleanup',
      registers: [registry],
    });
    this.llmUsageDeleted.inc(0);
  }

  registerPolicy(name: string): void {
    this.rowsDeleted.labels({ cron_name: name });
    this.cleanupErrors.labels({ cron_name: name });
  }

  incRowsDeleted(name: string, count: number): void {
    this.rowsDeleted.inc({ cron_name: name }, count);
  }

  incCleanupError(name: string): void {
    this.cleanupErrors.inc({ cron_name: name });
  }

  incLlmUsageDeleted(count: number): void {
    if (count > 0) this.llmUsageDeleted.inc(count);
  }
}
