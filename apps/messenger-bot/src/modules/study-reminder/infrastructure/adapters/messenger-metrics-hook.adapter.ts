import type { MetricsHook } from '@wispace/study-reminder-shared';
import { MetricsService } from '../../../metrics/metrics.service';

/**
 * Adapts Messenger's MetricsService to the shared MetricsHook port.
 */
export class MessengerReminderMetricsHook implements MetricsHook {
  constructor(private readonly metrics: MetricsService) {}

  onSent(): void {
    this.metrics.incReminderDispatch('sent');
  }

  onFailed(): void {
    this.metrics.incReminderDispatch('failed');
  }

  onRetried(): void {
    this.metrics.incReminderDispatch('retried');
  }

  onCancelled(): void {
    this.metrics.incReminderDispatch('cancelled');
  }
}
