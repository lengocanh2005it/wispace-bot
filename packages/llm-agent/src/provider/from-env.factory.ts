import type { LlmProviderAdapter } from './llm-provider.adapter';
import {
  createFailoverLlmProviderAdapter,
  createFailoverProviderEntries,
} from './factory';
import { OpenAiAdapter } from './openai/openai-adapter';
import type { FailoverConfig } from './factory';
import {
  buildLlmProviderPolicyFromEnv,
  type LlmProviderPolicy,
} from './provider-policy';

const DEFAULT_COOLDOWN_LONG_MS = 600_000;
const DEFAULT_COOLDOWN_SHORT_MS = 5_000;
const DEFAULT_QUICK_RETRY_DELAY_MS = 150;
const DEFAULT_RETRY_MAX_ATTEMPTS = 3;

type LlmProviderAdapterFromEnvOptions = Pick<
  FailoverConfig,
  | 'onCircuitEvent'
  | 'onProviderAttempt'
  | 'onProvidersExhausted'
  | 'maxAttempts'
> & { defaultProviderOrder?: string[]; policy?: LlmProviderPolicy };

function isLlmProviderPolicy(
  value: LlmProviderAdapterFromEnvOptions | LlmProviderPolicy | undefined,
): value is LlmProviderPolicy {
  return Boolean(
    value && 'allowedBaseUrlHosts' in value && 'allowedModels' in value,
  );
}

/**
 * Build the LLM provider adapter from environment variables — the shared
 * wiring previously duplicated in the Discord and Zalo app modules.
 * `LLM_PROVIDER_FAILOVER_ORDER` (comma-separated) drives failover; when
 * unset the order falls back to `options.defaultProviderOrder` (openai). The
 * policy may be supplied directly or is read from the shared allowlist env.
 */
export function createLlmProviderAdapterFromEnv(
  getEnv: (key: string) => string | undefined,
  optionsOrPolicy?: LlmProviderAdapterFromEnvOptions | LlmProviderPolicy,
  policy?: LlmProviderPolicy,
): LlmProviderAdapter {
  const options = isLlmProviderPolicy(optionsOrPolicy)
    ? undefined
    : optionsOrPolicy;
  const order = (getEnv('LLM_PROVIDER_FAILOVER_ORDER') ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const providerOrder = order.length
    ? order
    : (options?.defaultProviderOrder ?? ['openai']);
  const entries = createFailoverProviderEntries(getEnv, providerOrder);
  const executionFlag = getEnv('LLM_EXECUTION_ENABLED')?.trim().toLowerCase();
  if (
    executionFlag !== undefined &&
    executionFlag !== '' &&
    executionFlag !== 'true'
  ) {
    // Disabled execution must not leave a configured adapter that can send
    // prompts outside the bounded execution path. Keep the existing
    // unconfigured-adapter fallback semantics without requiring new policy
    // env vars while the gate is off.
    return new OpenAiAdapter(() => undefined);
  }
  const providerPolicy =
    policy ??
    (isLlmProviderPolicy(optionsOrPolicy)
      ? optionsOrPolicy
      : options?.policy) ??
    buildLlmProviderPolicyFromEnv(getEnv);
  const cooldownLongMs = Number(
    getEnv('LLM_FAILOVER_COOLDOWN_LONG_MS') ?? DEFAULT_COOLDOWN_LONG_MS,
  );
  const cooldownShortMs = Number(
    getEnv('LLM_FAILOVER_COOLDOWN_SHORT_MS') ?? DEFAULT_COOLDOWN_SHORT_MS,
  );
  const quickRetryDelayMs = Number(
    getEnv('LLM_FAILOVER_QUICK_RETRY_DELAY_MS') ?? DEFAULT_QUICK_RETRY_DELAY_MS,
  );
  const configuredMaxAttempts = Number(
    getEnv('LLM_OPENAI_RETRY_MAX_ATTEMPTS') ?? DEFAULT_RETRY_MAX_ATTEMPTS,
  );
  const maxAttempts =
    Number.isFinite(configuredMaxAttempts) && configuredMaxAttempts > 0
      ? Math.floor(configuredMaxAttempts)
      : DEFAULT_RETRY_MAX_ATTEMPTS;
  return createFailoverLlmProviderAdapter(
    entries,
    providerOrder,
    { warn: (m) => console.warn(m) },
    {
      cooldownLongMs,
      cooldownShortMs,
      quickRetryDelayMs,
      onCircuitEvent: options?.onCircuitEvent,
      onProviderAttempt: options?.onProviderAttempt,
      onProvidersExhausted: options?.onProvidersExhausted,
      maxAttempts: options?.maxAttempts ?? maxAttempts,
    },
    providerPolicy,
  );
}
