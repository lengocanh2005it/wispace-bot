import type { LlmProviderAdapter } from './llm-provider.adapter';
import { OpenAiAdapter } from './openai/openai-adapter';
import { OpenAiCompatibleAdapter } from './openai-compatible/openai-compatible-adapter';
import { OpenRouterAdapter } from './openrouter/openrouter-adapter';
import { MiniMaxAdapter } from './minimax/minimax-adapter';
import { FailoverLlmProviderAdapter } from './failover/failover-adapter';

export type LlmProviderType = string;

export interface LlmProviderEntryConfig {
  provider: string;
  getApiKey: () => string | undefined;
  getModel: () => string;
  getBaseUrl?: () => string | undefined;
}

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
  const provider = config.provider ?? 'openai';

  switch (provider) {
    case 'openai':
      return new OpenAiAdapter(
        config.getApiKey,
        config.getModel,
        config.getBaseUrl,
      );

    case 'openai-compatible':
      return new OpenAiCompatibleAdapter(
        config.getApiKey,
        config.getModel,
        config.getBaseUrl,
      );

    case 'openrouter':
      return new OpenRouterAdapter(
        config.getApiKey,
        config.getModel,
        config.getBaseUrl,
      );

    case 'minimax':
      return new MiniMaxAdapter(
        config.getApiKey,
        config.getModel,
        config.getBaseUrl,
      );

    default:
      // Fallback: try OpenAI adapter for unknown providers (may work if compatible)
      return new OpenAiAdapter(
        config.getApiKey,
        config.getModel,
        config.getBaseUrl,
        provider,
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
      getBaseUrl: () => get('OPENROUTER_BASE_URL'),
    }),
    minimax: () => ({
      provider: 'minimax',
      getApiKey: () => get('MINIMAX_API_KEY'),
      getModel: () => get('MINIMAX_MODEL') ?? 'MiniMax-Text-01',
      getBaseUrl: () => get('MINIMAX_BASE_URL'),
    }),
  };

  return order
    .map((name) => entryFor[name]?.())
    .filter((e): e is LlmProviderEntryConfig => Boolean(e));
}

export interface FailoverConfig {
  cooldownLongMs?: number;
  cooldownShortMs?: number;
  quickRetryDelayMs?: number;
}

/**
 * Build a failover chain following the given `order`.
 * Providers without configured API key are filtered out at build time.
 * If 0–1 provider is configured → returns that adapter directly (no failover wrapper),
 * preserving current behavior/latency for the most common case.
 */
export function createFailoverLlmProviderAdapter(
  entries: LlmProviderEntryConfig[],
  order: string[],
  logger?: { warn: (msg: string) => void },
  failoverConfig?: FailoverConfig,
): LlmProviderAdapter {
  const byProvider = new Map(entries.map((e) => [e.provider, e]));
  const orderedAdapters = order
    .map((name) => byProvider.get(name))
    .filter((e): e is LlmProviderEntryConfig => !!e)
    .map((e) => createLlmProviderAdapter(e))
    .filter((a) => a.isConfigured());

  if (orderedAdapters.length === 0) {
    throw new Error('No LLM provider configured in failover order');
  }
  if (orderedAdapters.length === 1) {
    return orderedAdapters[0];
  }
  return new FailoverLlmProviderAdapter(
    orderedAdapters,
    logger,
    Date.now,
    failoverConfig?.cooldownLongMs,
    failoverConfig?.cooldownShortMs,
    failoverConfig?.quickRetryDelayMs,
  );
}
