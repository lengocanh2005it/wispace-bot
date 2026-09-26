import {
  buildLlmProviderPolicyFromEnv,
  validateLlmProviderModel,
} from '@wispace/llm-agent/adapters';
import type { LlmProviderPolicy } from '@wispace/llm-agent/adapters';

export const DEFAULT_CLASSIFIER_MODEL = 'google/gemini-2.0-flash-lite';

export interface ClassifierConfig {
  enabled: boolean;
  executionEnabled?: boolean;
  model?: string;
  provider?: string;
  failoverOrder?: string;
  policy: LlmProviderPolicy;
}

/** Resolve the classifier model without guessing across a failover chain. */
export function resolveClassifierModel(config: ClassifierConfig): string {
  const model = config.model?.trim();
  if (!config.enabled || config.executionEnabled === false) {
    return model || DEFAULT_CLASSIFIER_MODEL;
  }

  const providerOrder = (config.failoverOrder ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (providerOrder.length > 1) {
    throw new Error(
      'LLM input classifier cannot run with an ambiguous multi-provider failover order',
    );
  }

  const provider = (providerOrder[0] ?? config.provider ?? 'openai')
    .trim()
    .toLowerCase();
  return validateLlmProviderModel(
    provider,
    model,
    config.policy,
    'LLM_INPUT_CLASSIFIER_MODEL',
  );
}

export function buildClassifierConfig(
  getEnv: (key: string) => string | undefined,
): ClassifierConfig {
  return {
    enabled:
      getEnv('LLM_INPUT_CLASSIFIER_ENABLED')?.trim().toLowerCase() === 'true',
    model: getEnv('LLM_INPUT_CLASSIFIER_MODEL'),
    provider: getEnv('LLM_PROVIDER'),
    failoverOrder: getEnv('LLM_PROVIDER_FAILOVER_ORDER'),
    policy: buildLlmProviderPolicyFromEnv(getEnv),
  };
}
