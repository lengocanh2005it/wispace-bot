import type { LlmProviderAdapter } from './llm-provider.adapter';
import {
  createFailoverLlmProviderAdapter,
  createFailoverProviderEntries,
} from './factory';

const DEFAULT_COOLDOWN_LONG_MS = 600_000;
const DEFAULT_COOLDOWN_SHORT_MS = 5_000;
const DEFAULT_QUICK_RETRY_DELAY_MS = 150;

/**
 * Build the LLM provider adapter from environment variables — the shared
 * wiring previously duplicated in the Discord and Zalo app modules.
 * `LLM_PROVIDER_FAILOVER_ORDER` (comma-separated) drives failover; when
 * unset the order falls back to `options.defaultProviderOrder` (openai).
 */
export function createLlmProviderAdapterFromEnv(
  getEnv: (key: string) => string | undefined,
  options?: { defaultProviderOrder?: string[] },
): LlmProviderAdapter {
  const order = (getEnv('LLM_PROVIDER_FAILOVER_ORDER') ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const providerOrder = order.length
    ? order
    : (options?.defaultProviderOrder ?? ['openai']);
  const entries = createFailoverProviderEntries(getEnv, providerOrder);
  const cooldownLongMs = Number(
    getEnv('LLM_FAILOVER_COOLDOWN_LONG_MS') ?? DEFAULT_COOLDOWN_LONG_MS,
  );
  const cooldownShortMs = Number(
    getEnv('LLM_FAILOVER_COOLDOWN_SHORT_MS') ?? DEFAULT_COOLDOWN_SHORT_MS,
  );
  const quickRetryDelayMs = Number(
    getEnv('LLM_FAILOVER_QUICK_RETRY_DELAY_MS') ?? DEFAULT_QUICK_RETRY_DELAY_MS,
  );
  return createFailoverLlmProviderAdapter(
    entries,
    providerOrder,
    { warn: (m) => console.warn(m) },
    { cooldownLongMs, cooldownShortMs, quickRetryDelayMs },
  );
}
