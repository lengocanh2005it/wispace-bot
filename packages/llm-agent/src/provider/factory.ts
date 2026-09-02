import type { LlmProviderAdapter } from './llm-provider.adapter';
import { OpenAiAdapter } from './openai/openai-adapter';
import {
  FailoverLlmProviderAdapter,
  type FailoverCircuitEvent,
} from './failover/failover-adapter';

export type LlmProviderType = string;

export interface LlmProviderEntryConfig {
  provider: string;
  getApiKey: () => string | undefined;
  getModel: () => string;
  getBaseUrl?: () => string | undefined;
}

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const MINIMAX_BASE_URL = 'https://api.minimax.chat/v1';

/**
 * Factory to create the appropriate LlmProviderAdapter based on the
 * LLM_PROVIDER environment variable.
 */
export function createLlmProviderAdapter(config: {
  getApiKey: () => string | undefined;
  getModel: () => string;
  getBaseUrl?: () => string | undefined;
  provider?: LlmProviderType;
}): LlmProviderAdapter {
  const provider = (config.provider ?? 'openai').trim().toLowerCase();

  switch (provider) {
    case 'openai':
      return new OpenAiAdapter(
        config.getApiKey,
        config.getModel,
        config.getBaseUrl,
      );

    case 'openai-compatible':
      if (!config.getBaseUrl?.()?.trim()) {
        throw new Error(
          'OPENAI-compatible provider requires a base URL (OPENAI_COMPATIBLE_BASE_URL)',
        );
      }
      return new OpenAiAdapter(
        config.getApiKey,
        config.getModel,
        config.getBaseUrl,
        'openai-compatible',
      );

    case 'openrouter':
      return new OpenAiAdapter(
        config.getApiKey,
        config.getModel,
        () => config.getBaseUrl?.()?.trim() || OPENROUTER_BASE_URL,
        'openrouter',
      );

    case 'minimax':
      return new OpenAiAdapter(
        config.getApiKey,
        config.getModel,
        () => config.getBaseUrl?.()?.trim() || MINIMAX_BASE_URL,
        'minimax',
      );

    default:
      throw new Error(
        `Unsupported LLM provider configuration: ${provider || '<empty>'}`,
      );
  }
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
      getModel: () => get('OPENAI_MODEL') ?? 'gpt-5.4',
      getBaseUrl: () => get('OPENAI_BASE_URL'),
    }),
    openrouter: () => ({
      provider: 'openrouter',
      getApiKey: () => get('OPENROUTER_API_KEY'),
      getModel: () => get('OPENROUTER_MODEL') ?? 'openai/gpt-4o-mini',
      getBaseUrl: () => get('OPENROUTER_BASE_URL') ?? OPENROUTER_BASE_URL,
    }),
    minimax: () => ({
      provider: 'minimax',
      getApiKey: () => get('MINIMAX_API_KEY'),
      getModel: () => get('MINIMAX_MODEL') ?? 'MiniMax-Text-01',
      getBaseUrl: () => get('MINIMAX_BASE_URL') ?? MINIMAX_BASE_URL,
    }),
    'openai-compatible': () => ({
      provider: 'openai-compatible',
      getApiKey: () => get('OPENAI_COMPATIBLE_API_KEY'),
      getModel: () => get('OPENAI_COMPATIBLE_MODEL') ?? 'gpt-5.4',
      getBaseUrl: () => get('OPENAI_COMPATIBLE_BASE_URL'),
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
  logger?: { warn: (msg: string) => void },
  failoverConfig?: FailoverConfig,
): LlmProviderAdapter {
  const byProvider = new Map(entries.map((e) => [e.provider, e]));
  const orderedAdapters = order.map((name) => {
    const entry = byProvider.get(name);
    if (!entry) {
      throw new Error(
        `LLM provider ${name} is listed in failover order but has no configuration`,
      );
    }
    const adapter = createLlmProviderAdapter(entry);
    if (!adapter.isConfigured()) {
      throw new Error(
        `LLM provider ${name} is listed in failover order but missing API key`,
      );
    }
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
    failoverConfig?.onProvidersExhausted,
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
  );
}
