/**
 * Centralized LLM execution configuration defaults and factory.
 *
 * Shared by PlatformAgentService (Discord/Zalo chat), PlatformStudentReportService
 * (Discord/Zalo reports), and can be used by Messenger's LlmExecutionConfigService.
 *
 * Env vars: LLM_EXECUTION_ENABLED, LLM_MAX_CONCURRENT,
 * LLM_GLOBAL_MAX_CONCURRENT, LLM_OPENAI_RETRY_MAX_ATTEMPTS,
 * LLM_OPENAI_RETRY_BACKOFF_MS, LLM_OPENAI_RETRY_MAX_DELAY_MS,
 * LLM_REQUEST_TIMEOUT_MS, LLM_GLOBAL_CONCURRENCY_ENABLED,
 * LLM_MAX_TOTAL_PROVIDER_ATTEMPTS
 */

import {
  DEFAULT_LLM_MAX_TOTAL_PROVIDER_ATTEMPTS,
  readMaxTotalProviderAttempts,
} from './attempt-budget';

export const LLM_EXECUTION_DEFAULTS = {
  enabled: true,
  maxConcurrent: 3,
  maxQueueDepth: 50,
  chatAdmissionWaitMs: 8_000,
  backgroundAdmissionWaitMs: 1_500,
  globalMaxConcurrent: 10,
  /** Per-provider retry attempts; the separate shared generation cap is below. */
  retryMaxAttempts: 1,
  retryBackoffMs: 2_000,
  retryMaxDelayMs: 10_000,
  requestTimeoutMs: 30_000,
  perAttemptTimeoutMs: 10_000,
  globalConcurrencyEnabled: false,
  maxTotalProviderAttempts: DEFAULT_LLM_MAX_TOTAL_PROVIDER_ATTEMPTS,
} as const;

export type LlmExecutionConfigReader = (key: string) => string | undefined;

function readBoolean(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined || value === null) return defaultValue;
  return value.toLowerCase() === 'true';
}

function readPositiveInt(
  value: string | undefined,
  defaultValue: number,
): number {
  if (value === undefined || value === null || value === '')
    return defaultValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

/**
 * Build LLM execution config from environment variables.
 * Falls back to documented defaults when env vars are missing or invalid.
 */
export function buildLlmExecutionConfig(
  env?: Record<string, string | undefined> | LlmExecutionConfigReader,
): {
  enabled: boolean;
  maxConcurrent: number;
  maxQueueDepth: number;
  chatAdmissionWaitMs: number;
  backgroundAdmissionWaitMs: number;
  globalMaxConcurrent: number;
  maxAttempts: number;
  baseBackoffMs: number;
  retryMaxDelayMs: number;
  requestTimeoutMs: number;
  perAttemptTimeoutMs: number;
  globalConcurrencyEnabled: boolean;
  maxTotalProviderAttempts: number;
} {
  const get: LlmExecutionConfigReader =
    typeof env === 'function' ? env : (key) => env?.[key] ?? process.env[key];

  return {
    enabled: readBoolean(
      get('LLM_EXECUTION_ENABLED'),
      LLM_EXECUTION_DEFAULTS.enabled,
    ),
    maxConcurrent: readPositiveInt(
      get('LLM_MAX_CONCURRENT'),
      LLM_EXECUTION_DEFAULTS.maxConcurrent,
    ),
    maxQueueDepth: readPositiveInt(
      get('LLM_MAX_QUEUE_DEPTH'),
      LLM_EXECUTION_DEFAULTS.maxQueueDepth,
    ),
    chatAdmissionWaitMs: readPositiveInt(
      get('LLM_ADMISSION_WAIT_MS'),
      LLM_EXECUTION_DEFAULTS.chatAdmissionWaitMs,
    ),
    backgroundAdmissionWaitMs: readPositiveInt(
      get('LLM_BACKGROUND_ADMISSION_WAIT_MS'),
      LLM_EXECUTION_DEFAULTS.backgroundAdmissionWaitMs,
    ),
    globalMaxConcurrent: readPositiveInt(
      get('LLM_GLOBAL_MAX_CONCURRENT'),
      LLM_EXECUTION_DEFAULTS.globalMaxConcurrent,
    ),
    maxAttempts: readPositiveInt(
      get('LLM_OPENAI_RETRY_MAX_ATTEMPTS'),
      LLM_EXECUTION_DEFAULTS.retryMaxAttempts,
    ),
    baseBackoffMs: readPositiveInt(
      get('LLM_OPENAI_RETRY_BACKOFF_MS'),
      LLM_EXECUTION_DEFAULTS.retryBackoffMs,
    ),
    retryMaxDelayMs: readPositiveInt(
      get('LLM_OPENAI_RETRY_MAX_DELAY_MS'),
      LLM_EXECUTION_DEFAULTS.retryMaxDelayMs,
    ),
    requestTimeoutMs: readPositiveInt(
      get('LLM_REQUEST_TIMEOUT_MS'),
      LLM_EXECUTION_DEFAULTS.requestTimeoutMs,
    ),
    perAttemptTimeoutMs: readPositiveInt(
      get('LLM_RETRY_PER_ATTEMPT_TIMEOUT_MS'),
      LLM_EXECUTION_DEFAULTS.perAttemptTimeoutMs,
    ),
    globalConcurrencyEnabled: readBoolean(
      get('LLM_GLOBAL_CONCURRENCY_ENABLED'),
      LLM_EXECUTION_DEFAULTS.globalConcurrencyEnabled,
    ),
    maxTotalProviderAttempts: readMaxTotalProviderAttempts(
      get('LLM_MAX_TOTAL_PROVIDER_ATTEMPTS'),
    ),
  };
}
