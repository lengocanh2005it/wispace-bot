import type { ChatQueueReconciliationResult } from './chat-queue-store.types';

export interface ChatQueueReconciliationMetrics {
  setRedisConsistencyDrift(datum: 'chat_queue', count: number): void;
  incRedisConsistencyEvent(
    datum: 'chat_queue',
    outcome:
      | 'detected'
      | 'repaired'
      | 'quarantined'
      | 'unresolved'
      | 'unavailable'
      | 'locked',
    count?: number,
  ): void;
}

export function recordChatQueueReconciliationMetrics(
  metrics: ChatQueueReconciliationMetrics | undefined,
  result: ChatQueueReconciliationResult,
): void {
  if (!metrics) return;
  metrics.setRedisConsistencyDrift('chat_queue', result.unresolved);
  if (result.mismatches > 0) {
    metrics.incRedisConsistencyEvent(
      'chat_queue',
      'detected',
      result.mismatches,
    );
  }
  if (result.repaired > 0) {
    metrics.incRedisConsistencyEvent('chat_queue', 'repaired', result.repaired);
  }
  if (result.quarantined > 0) {
    metrics.incRedisConsistencyEvent(
      'chat_queue',
      'quarantined',
      result.quarantined,
    );
  }
  if (result.unresolved > 0) {
    metrics.incRedisConsistencyEvent(
      'chat_queue',
      'unresolved',
      result.unresolved,
    );
  }
  if (result.status === 'unavailable' || result.status === 'locked') {
    metrics.incRedisConsistencyEvent('chat_queue', result.status);
  }
}
