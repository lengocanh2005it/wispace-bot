export interface BackgroundAdmissionCapacityConfig {
  maxConcurrent: number;
  maxQueueDepth: number;
  backgroundAdmissionWaitMs: number;
  requestTimeoutMs: number;
}

export interface BackgroundProducerConcurrencyOptions {
  enabled: boolean;
  producerName: string;
  configuredConcurrency?: number;
  onWarning?: (message: string) => void;
}

/**
 * Number of background generations that can be admitted inside the wait
 * budget, including the active slots and only the queue entries that can
 * drain before the request deadline (#1363).
 */
export function calculateBackgroundAdmissionCapacity(
  config: BackgroundAdmissionCapacityConfig,
): number {
  const slots = positiveInteger(config.maxConcurrent, 'maxConcurrent');
  const queueDepth = nonNegativeInteger(config.maxQueueDepth, 'maxQueueDepth');
  const waitMs = nonNegativeInteger(
    config.backgroundAdmissionWaitMs,
    'backgroundAdmissionWaitMs',
  );
  const requestTimeoutMs = positiveInteger(
    config.requestTimeoutMs,
    'requestTimeoutMs',
  );
  const usableQueueDepth = Math.floor((waitMs * slots) / requestTimeoutMs);

  return slots + Math.min(queueDepth, Math.max(0, usableQueueDepth));
}

/** Resolve the producer cap and fail closed when an explicit value is unsafe. */
export function resolveBackgroundProducerConcurrency(
  config: BackgroundAdmissionCapacityConfig,
  options: BackgroundProducerConcurrencyOptions,
): number {
  const capacity = calculateBackgroundAdmissionCapacity(config);
  const configured =
    options.configuredConcurrency === undefined
      ? capacity
      : positiveInteger(
          options.configuredConcurrency,
          `${options.producerName} concurrency`,
        );

  if (!options.enabled) {
    if (configured > capacity) {
      options.onWarning?.(
        `LLM execution disabled; ${options.producerName} producer cap is not enforced (configured concurrency ${configured}, capacity ${capacity})`,
      );
    }
    return configured;
  }

  if (configured > capacity) {
    throw new Error(
      `${options.producerName} concurrency ${configured} exceeds background admission capacity ${capacity}`,
    );
  }

  return configured;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return Math.floor(value);
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return Math.floor(value);
}
