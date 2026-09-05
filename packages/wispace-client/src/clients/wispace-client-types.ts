export interface WispaceApiClientConfig {
  url: string;
  internalKey: string;
  maxRetries?: number;
  baseDelayMs?: number;
  /** Request timeout in ms for fetch() calls. Default: 10_000 (10s). */
  requestTimeoutMs?: number;
  /**
   * Keep-alive connections per host (#567). Default: 6. Applies to the
   * shared per-host agent — first creator wins when endpoints share a host.
   */
  poolSize?: number;
  /** Optional adapter for recording the complete upstream operation latency. */
  metrics?: WispaceClientMetrics;
}

export interface WispaceClientMetrics {
  timeWispaceCall<T>(
    service: string,
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T>;
}

export interface WispaceClientLogger {
  warn(message: string): void;
  log(message: string): void;
}

export const NOOP_WISPACE_LOGGER: WispaceClientLogger = {
  warn: () => undefined,
  log: () => undefined,
};
