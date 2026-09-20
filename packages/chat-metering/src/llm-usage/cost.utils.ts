/** Env suffix convention: gpt-5.4 → GPT_5_4 */
export function normalizeModelForEnvKey(model: string): string {
  return model.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
}

export function normalizeProviderForEnvKey(provider: string): string {
  return provider.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
}

export function buildInputCostEnvKey(model: string): string {
  return `LLM_COST_USD_PER_1M_INPUT_TOKENS_${normalizeModelForEnvKey(model)}`;
}

export function buildOutputCostEnvKey(model: string): string {
  return `LLM_COST_USD_PER_1M_OUTPUT_TOKENS_${normalizeModelForEnvKey(model)}`;
}

export function buildCachedInputCostEnvKey(model: string): string {
  return `LLM_COST_USD_PER_1M_CACHED_INPUT_TOKENS_${normalizeModelForEnvKey(model)}`;
}

export function buildProviderInputCostEnvKey(
  provider: string,
  model: string,
): string {
  return `LLM_COST_USD_PER_1M_INPUT_TOKENS_${normalizeProviderForEnvKey(provider)}_${normalizeModelForEnvKey(model)}`;
}

export function buildProviderOutputCostEnvKey(
  provider: string,
  model: string,
): string {
  return `LLM_COST_USD_PER_1M_OUTPUT_TOKENS_${normalizeProviderForEnvKey(provider)}_${normalizeModelForEnvKey(model)}`;
}

export function buildProviderCachedInputCostEnvKey(
  provider: string,
  model: string,
): string {
  return `LLM_COST_USD_PER_1M_CACHED_INPUT_TOKENS_${normalizeProviderForEnvKey(provider)}_${normalizeModelForEnvKey(model)}`;
}

/** OpenAI's typical cached-input discount when no per-model price is configured. */
const DEFAULT_CACHED_INPUT_DISCOUNT = 0.5;

export function estimateCostUsd(
  promptTokens: number,
  completionTokens: number,
  inputUsdPer1M: number | null,
  outputUsdPer1M: number | null,
  cachedTokens = 0,
  cachedInputUsdPer1M: number | null = null,
): string | null {
  if (inputUsdPer1M === null || outputUsdPer1M === null) {
    return null;
  }

  const effectiveCachedTokens = Math.min(cachedTokens, promptTokens);
  const uncachedPromptTokens = promptTokens - effectiveCachedTokens;
  const cachedPrice =
    cachedInputUsdPer1M ?? inputUsdPer1M * DEFAULT_CACHED_INPUT_DISCOUNT;

  const cost =
    (uncachedPromptTokens / 1_000_000) * inputUsdPer1M +
    (effectiveCachedTokens / 1_000_000) * cachedPrice +
    (completionTokens / 1_000_000) * outputUsdPer1M;

  return cost.toFixed(6);
}

export function addCostUsdStrings(
  a: string | null,
  b: string | null,
): string | null {
  if (a === null && b === null) {
    return null;
  }

  const total = Number(a ?? 0) + Number(b ?? 0);
  return total.toFixed(6);
}
