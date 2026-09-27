export interface ChatRateLimitSettings {
  enabled: boolean;
  freeFormDailyLimit: number;
  burstPerMinute: number;
  timezone: string;
  whitelistedPsids: string[];
  /** Hiện "còn X lượt" khi remaining <= ngưỡng này (Phase 6). */
  remainingHintThreshold: number;
  /** H2: reserved kẹt quá TTL (ms) → refund + cho retry cùng message.mid. */
  stuckReservedMs: number;
  /** H5: giới hạn độ dài text sau debounce merge trước LLM. */
  mergedTextMaxChars: number;
  /** H5: burst 60s có đếm bản ghi refunded hay không. */
  burstCountsRefunded: boolean;
}
