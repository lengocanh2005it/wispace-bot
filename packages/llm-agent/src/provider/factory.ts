import type { LlmProviderAdapter } from './llm-provider.adapter';
import { OpenAiAdapter } from './openai/openai-adapter';
import {
  FailoverLlmProviderAdapter,
  type FailoverCircuitEvent,
  type FailoverProviderOutcome,
} from './failover/failover-adapter';
import {
  validateLlmProviderConfiguration,
  type LlmProviderPolicy,
} from './provider-policy';

export type LlmProviderType = string;

export interface LlmProviderEntryConfig {
  provider: string;
  getApiKey: () => string | undefined;
  apiKeyEnvKey?: string;
  getModel: () => string | undefined;
  getBaseUrl?: () => string | undefined;
  modelEnvKey?: string;
  baseUrlEnvKey?: string;
}

function validateProviderApiKey(
  provider: string,
  apiKey: string | undefined,
  apiKeyEnvKey: string,
): void {
  const value = apiKey?.trim();
  if (!value) {
    throw new Error(
      `LLM provider ${provider} is listed in failover order but missing API key (${apiKeyEnvKey})`,
    );
  }

  if (
    provider === 'openai' &&
    (!value.startsWith('sk-') || value.startsWith('sk-or-'))
  ) {
    throw new Error(
      `LLM provider ${provider} has an invalid API key format (${apiKeyEnvKey}); expected an OpenAI sk- key`,
    );
  }
  if (provider === 'openrouter' && !value.startsWith('sk-or-v1-')) {
    throw new Error(
      `LLM provider ${provider} has an invalid API key format (${apiKeyEnvKey}); expected an OpenRouter sk-or-v1- key`,
    );
  }
}

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const MINIMAX_BASE_URL = 'https://api.minimax.chat/v1';
const DEFAULT_BASE_URLS: Record<string, string | undefined> = {
  openai: OPENAI_BASE_URL,
  openrouter: OPENROUTER_BASE_URL,
  minimax: MINIMAX_BASE_URL,
  'openai-compatible': undefined,
};
const BASE_URL_ENV_KEYS: Record<string, string> = {
  openai: 'OPENAI_BASE_URL',
  openrouter: 'OPENROUTER_BASE_URL',
  minimax: 'MINIMAX_BASE_URL',
  'openai-compatible': 'OPENAI_COMPATIBLE_BASE_URL',
};
const MODEL_ENV_KEYS: Record<string, string> = {
  openai: 'OPENAI_MODEL',
  openrouter: 'OPENROUTER_MODEL',
  minimax: 'MINIMAX_MODEL',
  'openai-compatible': 'OPENAI_COMPATIBLE_MODEL',
};

/**
 * Factory to create the appropriate LlmProviderAdapter after validating its
 * resolved endpoint and provider/model policy.
 */
export function createLlmProviderAdapter(config: {
  getApiKey: () => string | undefined;
  getModel: () => string | undefined;
  getBaseUrl?: () => string | undefined;
  provider?: LlmProviderType;
  policy?: LlmProviderPolicy;
  modelEnvKey?: string;
  baseUrlEnvKey?: string;
}): LlmProviderAdapter {
  const provider = assertSupportedLlmProvider(config.provider ?? 'openai');

  const defaultBaseUrl = DEFAULT_BASE_URLS[provider];
  const baseUrl = config.getBaseUrl?.()?.trim() || defaultBaseUrl;
  const baseUrlEnvKey =
    config.baseUrlEnvKey ?? BASE_URL_ENV_KEYS[provider] ?? 'base URL';
  const modelEnvKey = config.modelEnvKey ?? MODEL_ENV_KEYS[provider] ?? 'model';
  if (!baseUrl) {
    if (provider === 'openai-compatible') {
      throw new Error(
        `OPENAI-compatible provider requires a base URL (${baseUrlEnvKey})`,
      );
    }
    throw new Error(
      `LLM provider ${provider} requires a base URL (${baseUrlEnvKey})`,
    );
  }

  const validated = validateLlmProviderConfiguration(
    {
      provider,
      model: config.getModel(),
      baseUrl,
      modelEnvKey,
      baseUrlEnvKey,
    },
    config.policy,
  );

  return new OpenAiAdapter(
    config.getApiKey,
    () => validated.model,
    () => validated.baseUrl,
    provider,
    config.policy,
  );
}

export function assertSupportedLlmProvider(providerValue: string): string {
  const provider = providerValue.trim().toLowerCase();
  if (!(provider in DEFAULT_BASE_URLS)) {
    throw new Error(
      `Unsupported LLM provider configuration: ${provider || '<empty>'}`,
    );
  }
  return provider;
}

/**
 * Build failover entries for the given order from a config getter.
 * Reads standard env keys: OPENAI_*, OPENROUTER_*, MINIMAX_*.
 */
export function createFailoverProviderEntries(
  get: (key: string) => string | undefined,
  order: string[],
): LlmProviderEntryConfig[] {
  const entryFor: Record<string, () => LlmProviderEntryConfig> = {
    openai: () => ({
      provider: 'openai',
      getApiKey: () => get('OPENAI_API_KEY'),
      apiKeyEnvKey: 'OPENAI_API_KEY',
      getModel: () => get('OPENAI_MODEL'),
      getBaseUrl: () => get('OPENAI_BASE_URL'),
      modelEnvKey: 'OPENAI_MODEL',
      baseUrlEnvKey: 'OPENAI_BASE_URL',
    }),
    openrouter: () => ({
      provider: 'openrouter',
      getApiKey: () => get('OPENROUTER_API_KEY'),
      apiKeyEnvKey: 'OPENROUTER_API_KEY',
      getModel: () => get('OPENROUTER_MODEL'),
      getBaseUrl: () => get('OPENROUTER_BASE_URL'),
      modelEnvKey: 'OPENROUTER_MODEL',
      baseUrlEnvKey: 'OPENROUTER_BASE_URL',
    }),
    minimax: () => ({
      provider: 'minimax',
      getApiKey: () => get('MINIMAX_API_KEY'),
      apiKeyEnvKey: 'MINIMAX_API_KEY',
      getModel: () => get('MINIMAX_MODEL'),
      getBaseUrl: () => get('MINIMAX_BASE_URL'),
      modelEnvKey: 'MINIMAX_MODEL',
      baseUrlEnvKey: 'MINIMAX_BASE_URL',
    }),
    'openai-compatible': () => ({
      provider: 'openai-compatible',
      getApiKey: () => get('OPENAI_COMPATIBLE_API_KEY'),
      apiKeyEnvKey: 'OPENAI_COMPATIBLE_API_KEY',
      getModel: () => get('OPENAI_COMPATIBLE_MODEL'),
      getBaseUrl: () => get('OPENAI_COMPATIBLE_BASE_URL'),
      modelEnvKey: 'OPENAI_COMPATIBLE_MODEL',
      baseUrlEnvKey: 'OPENAI_COMPATIBLE_BASE_URL',
    }),
  };

  return order.map((name) => {
    const createEntry = entryFor[name];
    if (!createEntry) {
      throw new Error(`Unsupported LLM provider configuration: ${name}`);
    }
    return createEntry();
  });
}

export interface FailoverConfig {
  cooldownLongMs?: number;
  cooldownShortMs?: number;
  quickRetryDelayMs?: number;
  onCircuitEvent?: (event: FailoverCircuitEvent) => void;
  onProviderAttempt?: (provider: string, feature?: string) => void;
  onProvidersExhausted?: (providers: string[], feature?: string) => void;
  maxAttempts?: number;
  onProviderOutcome?: (
    provider: string,
    outcome: FailoverProviderOutcome,
    feature?: string,
  ) => void;
  onProviderNeverSucceeded?: (provider: string, feature?: string) => void;
}

/**
 * Build a failover chain following the given `order`.
 * Every provider in the requested order must be known and configured.
 * A single provider stays direct unless failover telemetry or a retry budget is
 * requested; those options need the shared wrapper even without a fallback.
 * A warning is emitted when only one provider is configured.
 */
export function createFailoverLlmProviderAdapter(
  entries: LlmProviderEntryConfig[],
  order: string[],
  logger?: { warn: (msg: string) => void; error?: (msg: string) => void },
  failoverConfig?: FailoverConfig,
  policy?: LlmProviderPolicy,
): LlmProviderAdapter {
  const byProvider = new Map(entries.map((e) => [e.provider, e]));
  const orderedAdapters = order.map((name) => {
    const entry = byProvider.get(name);
    if (!entry) {
      throw new Error(
        `LLM provider ${name} is listed in failover order but has no configuration`,
      );
    }
    const provider = assertSupportedLlmProvider(entry.provider);
    validateProviderApiKey(
      provider,
      entry.getApiKey(),
      entry.apiKeyEnvKey ?? 'API key',
    );
    const adapter = createLlmProviderAdapter({ ...entry, policy });
    return adapter;
  });

  if (orderedAdapters.length === 0) {
    throw new Error('No LLM provider configured in failover order');
  }
  if (orderedAdapters.length === 1) {
    logger?.warn(
      `Only one LLM provider configured (${orderedAdapters[0].providerName}); failover redundancy is unavailable`,
    );
  }
  const needsFailoverWrapper = Boolean(
    failoverConfig?.maxAttempts !== undefined ||
    failoverConfig?.onCircuitEvent ||
    failoverConfig?.onProviderAttempt ||
    failoverConfig?.onProvidersExhausted ||
    failoverConfig?.onProviderOutcome ||
    failoverConfig?.onProviderNeverSucceeded,
  );
  if (orderedAdapters.length === 1 && !needsFailoverWrapper) {
    return orderedAdapters[0];
  }
  return new FailoverLlmProviderAdapter(
    orderedAdapters,
    logger,
    Date.now,
    failoverConfig?.cooldownLongMs,
    failoverConfig?.cooldownShortMs,
    failoverConfig?.quickRetryDelayMs,
    failoverConfig?.onCircuitEvent,
    failoverConfig?.onProviderAttempt,
    failoverConfig?.onProvidersExhausted,
    failoverConfig?.maxAttempts,
    failoverConfig?.onProviderOutcome,
    failoverConfig?.onProviderNeverSucceeded,
  );
}
