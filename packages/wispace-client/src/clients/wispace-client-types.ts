export interface WispaceApiClientConfig {
  url: string;
  internalKey: string;
  maxRetries?: number;
  baseDelayMs?: number;
  /** Request timeout in ms for fetch() calls. Default: 10_000 (10s). */
  requestTimeoutMs?: number;
}

export interface WispaceClientLogger {
  warn(message: string): void;
  log(message: string): void;
}

export const NOOP_WISPACE_LOGGER: WispaceClientLogger = {
  warn: () => undefined,
  log: () => undefined,
};
