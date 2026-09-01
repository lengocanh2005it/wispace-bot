import { join } from 'path';
import {
  runGuardrailBattery,
  runGuardrailBatteryFromDir,
  summarizeBattery,
  ADVERSARIAL_BYPASS_RATE_LIMIT,
} from './guardrail-battery';
import type { EvalFixtureResult } from './eval-harness';

function result(name: string, ok: boolean): EvalFixtureResult {
  return { name, ok, failures: ok ? [] : ['forced failure'], summary: '' };
}

describe('guardrail battery (#635)', () => {
  it('exposes the bypass-rate threshold', () => {
    expect(ADVERSARIAL_BYPASS_RATE_LIMIT).toBe(0.1);
  });

  it('passes when every fixture is green regardless of tier', () => {
    const outcome = runGuardrailBattery(
      [result('control-a', true), result('injection-b', true)],
      ['injection-b'],
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.mustBlock.total).toBe(1);
    expect(outcome.adversarial.total).toBe(1);
    expect(outcome.adversarial.bypassRate).toBe(0);
  });

  it('fails when a must-block fixture regresses — 100% required', () => {
    const outcome = runGuardrailBattery([result('control-a', false)], []);
    expect(outcome.ok).toBe(false);
    expect(outcome.mustBlock.failed).toEqual(['control-a']);
  });

  it('adversarial bypasses within the threshold do not fail the check', () => {
    const names = ['inj-1', 'inj-2', 'inj-3', 'inj-4', 'inj-5'];
    const results = names.map((name, i) => result(name, i >= 1 ? false : true));
    // 4/5 bypassed = 80% — way over the 10% limit.
    const failing = runGuardrailBattery(results, names);
    expect(failing.ok).toBe(false);

    // 1/5 bypassed = 20% — still over.
    const oneBypass = runGuardrailBattery(
      names.map((name, i) => result(name, i === 0 ? false : true)),
      names,
    );
    expect(oneBypass.ok).toBe(false);

    // 0 bypasses pass.
    const clean = runGuardrailBattery(
      names.map((name) => result(name, true)),
      names,
    );
    expect(clean.ok).toBe(true);
  });

  it('reports the bypass rate per run so drift is visible', () => {
    const names = ['inj-1', 'inj-2', 'inj-3', 'inj-4', 'inj-5', 'inj-6'];
    const outcome = runGuardrailBattery(
      names.map((name, i) => result(name, i !== 5)),
      names,
    );
    expect(outcome.adversarial.total).toBe(6);
    expect(outcome.adversarial.bypassRate).toBeCloseTo(1 / 6);
    expect(outcome.adversarial.failed).toEqual(['inj-6']);
  });

  it('treats unknown fixture names as must-block (missing tier defaults safe)', () => {
    const outcome = runGuardrailBattery([result('unlisted', false)], []);
    expect(outcome.ok).toBe(false);
    expect(outcome.mustBlock.failed).toEqual(['unlisted']);
  });

  it('summarizeBattery names regressed fixtures and the verdict', () => {
    const summary = summarizeBattery(
      runGuardrailBattery([result('control-a', false)], []),
    );
    expect(summary).toContain('MUST-BLOCK REGRESSIONS: control-a');
    expect(summary).toContain('GUARDRAIL BATTERY: FAIL');
    expect(summary).toContain('bypass rate');
  });

  describe('real fixtures dir (integration, current tree)', () => {
    const FIXTURES_DIR = join(__dirname, '../../fixtures');

    it('passes the battery on the current tree — 100% must-block, adversarial within limit', async () => {
      const outcome = await runGuardrailBatteryFromDir(FIXTURES_DIR);
      expect(outcome.mustBlock.failed).toEqual([]);
      expect(outcome.adversarial.bypassRate).toBeLessThanOrEqual(
        ADVERSARIAL_BYPASS_RATE_LIMIT,
      );
      expect(outcome.ok).toBe(true);
    }, 120_000);
  });
});
