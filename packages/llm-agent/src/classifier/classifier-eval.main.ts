/**
 * #649 / #505 — manual + nightly classifier label-accuracy lane. NOT part of
 * PR CI `verify`: it calls a real provider. Compiled entry so
 * `npm run classifier:eval --workspace=@wispace/llm-agent` needs no extra
 * tooling (mirrors `eval:guardrail`).
 *
 * - No provider key in the environment → prints a notice and exits 0 (the
 *   nightly workflow stays green until a maintainer adds the secret).
 * - Accuracy below `CLASSIFIER_EVAL_MIN_ACCURACY` (default 0.8) → exits 1.
 */
import { createLlmProviderAdapterFromEnv } from '../provider/from-env.factory';
import { CLASSIFIER_EVAL_CASES } from './classifier-eval.fixtures';
import { runClassifierEval, summarizeClassifierEval } from './classifier-eval';

const minAccuracy = Number(
  process.env['CLASSIFIER_EVAL_MIN_ACCURACY'] ?? '0.8',
);
const model =
  process.env['LLM_INPUT_CLASSIFIER_MODEL']?.trim() ||
  'google/gemini-2.0-flash-lite';

function buildAdapterOrNull() {
  const order = process.env['OPENROUTER_API_KEY'] ? ['openrouter'] : ['openai'];
  try {
    const adapter = createLlmProviderAdapterFromEnv((key) => process.env[key], {
      defaultProviderOrder: order,
    });
    return adapter.isConfigured() ? adapter : null;
  } catch {
    return null;
  }
}

const adapter = buildAdapterOrNull();
if (!adapter) {
  console.log(
    'classifier eval: no LLM provider configured (set OPENROUTER_API_KEY or OPENAI_API_KEY) — skipping.',
  );
  process.exit(0);
}

runClassifierEval(adapter, model, CLASSIFIER_EVAL_CASES)
  .then((outcome) => {
    console.log(summarizeClassifierEval(outcome));
    if (outcome.accuracy < minAccuracy) {
      console.error(
        `classifier eval FAILED: accuracy ${(outcome.accuracy * 100).toFixed(
          1,
        )}% < floor ${(minAccuracy * 100).toFixed(1)}%`,
      );
      process.exit(1);
    }
  })
  .catch((error: unknown) => {
    console.error(
      `classifier eval failed to run: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  });
