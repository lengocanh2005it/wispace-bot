import {
  validateUpstreamUrl,
  type UpstreamUrlPolicy,
} from '@wispace/bot-common/utils';

export interface LlmProviderPolicy {
  /** Exact hostnames allowed for every active provider endpoint. */
  allowedBaseUrlHosts: readonly string[];
  /** Exact, case-sensitive `provider:model` pairs allowed at runtime. */
  allowedModels: readonly string[];
  nodeEnv?: string;
}

export interface LlmProviderValidationInput {
  provider: string;
  model: string | undefined;
  baseUrl: string;
  modelEnvKey?: string;
  baseUrlEnvKey?: string;
}

const EMPTY_POLICY: LlmProviderPolicy = {
  allowedBaseUrlHosts: [],
  allowedModels: [],
};

function parseCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Build the shared provider policy from the process environment representation. */
export function buildLlmProviderPolicyFromEnv(
  getEnv: (key: string) => string | undefined,
): LlmProviderPolicy {
  return {
    nodeEnv: getEnv('NODE_ENV')?.trim() || undefined,
    allowedBaseUrlHosts: parseCsv(getEnv('LLM_ALLOWED_BASE_URLS')),
    allowedModels: parseCsv(getEnv('LLM_ALLOWED_MODELS')),
  };
}

export function validateLlmProviderModel(
  provider: string,
  model: string | undefined,
  policy: LlmProviderPolicy,
  modelEnvKey = 'model',
): string {
  if (!policy.allowedModels.some((approved) => approved.trim().length > 0)) {
    throw new Error(
      `LLM provider ${provider} requires a non-empty LLM_ALLOWED_MODELS allowlist`,
    );
  }

  const normalizedModel = model?.trim();
  if (!normalizedModel) {
    throw new Error(
      `LLM provider ${provider} ${modelEnvKey} must be explicitly configured`,
    );
  }

  const pair = `${provider}:${normalizedModel}`;
  if (!policy.allowedModels.some((approved) => approved.trim() === pair)) {
    throw new Error(
      `LLM provider ${provider} ${modelEnvKey} model ${normalizedModel} is not approved by LLM_ALLOWED_MODELS`,
    );
  }
  return normalizedModel;
}

/** Validate one resolved provider endpoint and its explicit model. */
export function validateLlmProviderConfiguration(
  input: LlmProviderValidationInput,
  policy: LlmProviderPolicy | undefined,
): { model: string; baseUrl: string } {
  const effectivePolicy = policy ?? EMPTY_POLICY;
  const baseUrlEnvKey = input.baseUrlEnvKey ?? 'base URL';
  const upstreamPolicy: UpstreamUrlPolicy = {
    context: `LLM provider ${input.provider} ${baseUrlEnvKey}`,
    nodeEnv: effectivePolicy.nodeEnv,
    allowedHosts: effectivePolicy.allowedBaseUrlHosts,
    allowlistName: 'LLM_ALLOWED_BASE_URLS',
    requireAllowedHosts: true,
  };

  const baseUrl = validateUpstreamUrl(input.baseUrl, upstreamPolicy);
  const model = validateLlmProviderModel(
    input.provider,
    input.model,
    effectivePolicy,
    input.modelEnvKey ?? 'model',
  );
  return { model, baseUrl };
}
