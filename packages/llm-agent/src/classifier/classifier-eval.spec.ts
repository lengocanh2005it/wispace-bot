import type { LlmProviderAdapter } from '../provider/llm-provider.adapter';
import { runClassifierEval, summarizeClassifierEval } from './classifier-eval';
import { CLASSIFIER_EVAL_CASES } from './classifier-eval.fixtures';

function scriptedAdapter(labels: readonly string[]): LlmProviderAdapter {
  let i = 0;
  return {
    generateJson: jest.fn(async () => ({
      content: JSON.stringify({
        label: labels[i++],
        confidence: 0.9,
        reason: 'x',
      }),
      metadata: { provider: 'eval', model: 'm' },
    })),
  } as unknown as LlmProviderAdapter;
}

describe('classifier-eval fixtures', () => {
  it('every case has a valid label and non-empty text', () => {
    for (const c of CLASSIFIER_EVAL_CASES) {
      expect(['SAFE', 'INJECTION', 'DISCLOSURE_PROBE']).toContain(c.expected);
      expect(c.text.trim().length).toBeGreaterThan(0);
    }
  });

  it('covers all three labels with a meaningful sample size', () => {
    expect(CLASSIFIER_EVAL_CASES.length).toBeGreaterThanOrEqual(20);
    const labels = new Set(CLASSIFIER_EVAL_CASES.map((c) => c.expected));
    expect(labels).toEqual(new Set(['SAFE', 'INJECTION', 'DISCLOSURE_PROBE']));
  });
});

describe('runClassifierEval', () => {
  const cases = [
    { text: 'a', expected: 'SAFE' as const },
    { text: 'b', expected: 'INJECTION' as const },
    { text: 'c', expected: 'DISCLOSURE_PROBE' as const, note: 'probe' },
  ];

  it('tallies accuracy, per-label breakdown and misses', async () => {
    // 3rd answer wrong (SAFE instead of DISCLOSURE_PROBE)
    const adapter = scriptedAdapter(['SAFE', 'INJECTION', 'SAFE']);
    const outcome = await runClassifierEval(adapter, 'm', cases);

    expect(outcome.total).toBe(3);
    expect(outcome.correct).toBe(2);
    expect(outcome.accuracy).toBeCloseTo(2 / 3);
    expect(outcome.parseFailures).toBe(0);
    expect(outcome.perLabel.DISCLOSURE_PROBE).toEqual({ total: 1, correct: 0 });
    expect(outcome.misses).toEqual([
      { text: 'c', expected: 'DISCLOSURE_PROBE', got: 'SAFE', note: 'probe' },
    ]);
    expect(summarizeClassifierEval(outcome)).toContain('2/3 correct');
  });

  it('counts unparseable / errored responses as parse failures', async () => {
    const adapter = {
      generateJson: jest
        .fn()
        .mockResolvedValueOnce({ content: 'garbage', metadata: {} })
        .mockRejectedValueOnce(new Error('boom')),
    } as unknown as LlmProviderAdapter;
    const outcome = await runClassifierEval(adapter, 'm', [
      { text: 'a', expected: 'SAFE' as const },
      { text: 'b', expected: 'INJECTION' as const },
    ]);
    expect(outcome.parseFailures).toBe(2);
    expect(outcome.correct).toBe(0);
    expect(outcome.misses.map((m) => m.got)).toEqual([
      'PARSE_FAILED',
      'PARSE_FAILED',
    ]);
  });
});
