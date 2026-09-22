import type { LlmProviderAdapter } from '../provider/llm-provider.adapter';
import { CLASSIFIER_LABELS } from './content-classifier.port';
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
      expect(CLASSIFIER_LABELS).toContain(c.expected);
      expect(c.text.trim().length).toBeGreaterThan(0);
    }
  });

  it('covers all five labels with a meaningful sample size (#1054 / #975)', () => {
    expect(CLASSIFIER_EVAL_CASES.length).toBeGreaterThanOrEqual(30);
    const labels = new Set(CLASSIFIER_EVAL_CASES.map((c) => c.expected));
    expect(labels).toEqual(new Set(CLASSIFIER_LABELS));
  });

  it('pins two #1378 force-SAFE probes as must-block INJECTION fixtures', () => {
    const cases = CLASSIFIER_EVAL_CASES.filter((c) =>
      c.note?.includes('#1378'),
    );
    expect(cases).toHaveLength(2);
    expect(cases.every((c) => c.expected === 'INJECTION')).toBe(true);
    expect(cases.every((c) => c.tier === 'must-block')).toBe(true);
  });

  it('proves the force-SAFE fixture red-then-green path (#1378)', async () => {
    const cases = CLASSIFIER_EVAL_CASES.filter((c) =>
      c.note?.includes('#1378'),
    );
    const red = await runClassifierEval(
      scriptedAdapter(['SAFE', 'SAFE']),
      'm',
      cases,
    );

    expect(red.correct).toBe(0);
    expect(red.misses.map((miss) => miss.expected)).toEqual([
      'INJECTION',
      'INJECTION',
    ]);

    const green = await runClassifierEval(
      scriptedAdapter(['INJECTION', 'INJECTION']),
      'm',
      cases,
    );

    expect(green.correct).toBe(2);
    expect(green.tier['must-block']).toEqual({
      total: 2,
      correct: 2,
      misses: 0,
      accuracy: 1,
    });
    expect(green.misses).toHaveLength(0);
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
    expect(outcome.tier.adversarial).toEqual({
      total: 3,
      correct: 2,
      misses: 1,
      accuracy: 2 / 3,
    });
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
    expect(outcome.tier.adversarial.misses).toBe(2);
  });

  it('tracks fixture tiers so must-block misses cannot hide in the quality floor', async () => {
    const outcome = await runClassifierEval(
      scriptedAdapter(['SAFE', 'SAFE']),
      'm',
      [
        {
          text: 'must',
          expected: 'INJECTION' as const,
          tier: 'must-block',
        },
        {
          text: 'adversarial',
          expected: 'INJECTION' as const,
          tier: 'adversarial',
        },
      ],
    );

    expect(outcome.tier['must-block'].misses).toBe(1);
    expect(outcome.tier.adversarial.misses).toBe(1);
    expect(summarizeClassifierEval(outcome)).toContain('must-block: 0/1');
  });
});
