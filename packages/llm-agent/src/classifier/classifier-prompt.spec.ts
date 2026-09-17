import { CLASSIFIER_LABELS } from './content-classifier.port';
import { CLASSIFIER_SYSTEM_PROMPT } from './classifier-prompt';

describe('CLASSIFIER_SYSTEM_PROMPT', () => {
  const p = CLASSIFIER_SYSTEM_PROMPT;

  it('pins the JSON output contract with all five labels (#1054 / #975)', () => {
    expect(p).toContain('"label"');
    expect(p).toContain('"confidence"');
    expect(p).toContain('"reason"');
    for (const label of CLASSIFIER_LABELS) {
      expect(p).toContain(`"${label}"`);
    }
  });

  it('defines all five labels (#1054 / #975)', () => {
    for (const label of CLASSIFIER_LABELS) {
      expect(p).toMatch(new RegExp(`${label}\\s+[—-]|${label}\\s+--`));
    }
  });

  it('pins the CRISIS intent boundary and ambiguity rule (#1054)', () => {
    expect(p.toLowerCase()).toContain('self-harm');
    expect(p.toLowerCase()).toContain('suicidal');
    expect(p.toLowerCase()).toContain('immediate danger');
    expect(p).toContain('prefer CRISIS');
  });

  it('pins the ABUSE definition (#975)', () => {
    expect(p.toLowerCase()).toContain('hostil');
    expect(p.toLowerCase()).toContain('insult');
    expect(p.toLowerCase()).toContain('third party');
  });

  it('pins the SAFE boundary for study stress, burnout, and app complaints (#1054)', () => {
    expect(p.toLowerCase()).toContain('burnout');
    expect(p.toLowerCase()).toContain('app complaint');
  });

  it('routes system-prompt extraction to INJECTION with an "extraction" reason', () => {
    expect(p).toContain('extraction');
  });

  it('embeds the disclosure taxonomy', () => {
    for (const kw of [
      'model',
      'provider',
      'system prompt',
      'temperature',
      'infrastructure',
      'tool',
    ]) {
      expect(p.toLowerCase()).toContain(kw);
    }
  });

  it('keeps off-topic and essay-writing out of scope for this classifier', () => {
    expect(p.toLowerCase()).toContain('off-topic');
    expect(p.toLowerCase()).toContain('essay');
  });

  it('explains the head-and-tail sample marker', () => {
    expect(p).toContain('head-and-tail');
    expect(p).toContain('middle was omitted');
    expect(p).toContain('not safe');
  });

  it('carries a few-shot block', () => {
    expect(p).toContain('Examples:');
    // at least 8 example JSON objects
    expect((p.match(/\{"label":/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });

  it('stays within a sane size ceiling', () => {
    expect(p.length).toBeLessThan(7000);
  });
});
