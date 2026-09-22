/**
 * #649 / #505 — label-accuracy evaluation for the input classifier. Calls a
 * real provider with `CLASSIFIER_SYSTEM_PROMPT` over a curated fixture set and
 * tallies accuracy + per-label breakdown + misses. This is the *quality* lane
 * the offline eval harness cannot cover (scripted model); it runs manually or
 * nightly, never in PR CI. The harness logic here is pure and unit-tested
 * against a scripted adapter — only `classifier-eval.main.ts` reaches a real
 * provider.
 */
import type { LlmProviderAdapter } from '../provider/llm-provider.adapter';
import { CLASSIFIER_SYSTEM_PROMPT } from './classifier-prompt';
import {
  CLASSIFIER_LABELS,
  type ClassifierLabel,
} from './content-classifier.port';

export interface ClassifierEvalCase {
  text: string;
  expected: ClassifierLabel;
  /** #635 tier; classifier-quality fixtures stay adversarial unless promoted. */
  tier?: 'must-block' | 'adversarial';
  /** Why this case matters — shown in the miss report. */
  note?: string;
}

type Got = ClassifierLabel | 'PARSE_FAILED';

export interface ClassifierEvalTierOutcome {
  total: number;
  correct: number;
  misses: number;
  /** correct / total (1 when total is 0). */
  accuracy: number;
}

export interface ClassifierEvalOutcome {
  total: number;
  correct: number;
  /** correct / total (1 when total is 0). */
  accuracy: number;
  parseFailures: number;
  perLabel: Record<ClassifierLabel, { total: number; correct: number }>;
  tier: Record<'must-block' | 'adversarial', ClassifierEvalTierOutcome>;
  misses: Array<{
    text: string;
    expected: ClassifierLabel;
    got: Got;
    note?: string;
  }>;
}

function parseLabel(raw: string): ClassifierLabel | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      obj = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  const label = (obj as { label?: unknown } | null)?.label;
  return typeof label === 'string' &&
    (CLASSIFIER_LABELS as readonly string[]).includes(label)
    ? (label as ClassifierLabel)
    : null;
}

export async function runClassifierEval(
  adapter: LlmProviderAdapter,
  model: string,
  cases: readonly ClassifierEvalCase[],
): Promise<ClassifierEvalOutcome> {
  const perLabel = Object.fromEntries(
    CLASSIFIER_LABELS.map((lbl) => [lbl, { total: 0, correct: 0 }]),
  ) as ClassifierEvalOutcome['perLabel'];

  const misses: ClassifierEvalOutcome['misses'] = [];
  let correct = 0;
  let parseFailures = 0;
  const tier: ClassifierEvalOutcome['tier'] = {
    'must-block': { total: 0, correct: 0, misses: 0, accuracy: 1 },
    adversarial: { total: 0, correct: 0, misses: 0, accuracy: 1 },
  };

  for (const testCase of cases) {
    const testTier = testCase.tier ?? 'adversarial';
    tier[testTier].total += 1;
    perLabel[testCase.expected].total += 1;
    let got: Got;
    try {
      const res = await adapter.generateJson({
        feature: 'FREE_FORM_CHAT',
        model,
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        userContent: testCase.text,
        maxOutputTokens: 120,
      });
      got = parseLabel(res.content) ?? 'PARSE_FAILED';
    } catch {
      got = 'PARSE_FAILED';
    }

    if (got === 'PARSE_FAILED') {
      parseFailures += 1;
    }
    if (got === testCase.expected) {
      correct += 1;
      perLabel[testCase.expected].correct += 1;
      tier[testTier].correct += 1;
    } else {
      tier[testTier].misses += 1;
      misses.push({
        text: testCase.text,
        expected: testCase.expected,
        got,
        note: testCase.note,
      });
    }
  }

  for (const stats of Object.values(tier)) {
    stats.accuracy = stats.total === 0 ? 1 : stats.correct / stats.total;
  }

  return {
    total: cases.length,
    correct,
    accuracy: cases.length === 0 ? 1 : correct / cases.length,
    parseFailures,
    perLabel,
    tier,
    misses,
  };
}

export function summarizeClassifierEval(
  outcome: ClassifierEvalOutcome,
): string {
  const lines: string[] = [
    `classifier eval — ${outcome.correct}/${outcome.total} correct (${(
      outcome.accuracy * 100
    ).toFixed(1)}%), parse failures: ${outcome.parseFailures}`,
  ];
  for (const label of CLASSIFIER_LABELS) {
    const p = outcome.perLabel[label];
    lines.push(`  ${label}: ${p.correct}/${p.total}`);
  }

  for (const tier of ['must-block', 'adversarial'] as const) {
    const stats = outcome.tier[tier];
    lines.push(
      `  ${tier}: ${stats.correct}/${stats.total} (${(
        stats.accuracy * 100
      ).toFixed(1)}%), misses: ${stats.misses}`,
    );
  }

  if (outcome.misses.length > 0) {
    lines.push('  misses:');
    for (const m of outcome.misses) {
      lines.push(
        `    [expected ${m.expected}, got ${m.got}] ${JSON.stringify(m.text)}${
          m.note ? ` — ${m.note}` : ''
        }`,
      );
    }
  }
  return lines.join('\n');
}
