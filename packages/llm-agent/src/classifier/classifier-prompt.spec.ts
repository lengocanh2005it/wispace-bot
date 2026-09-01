import { CLASSIFIER_SYSTEM_PROMPT } from './classifier-prompt';

describe('CLASSIFIER_SYSTEM_PROMPT', () => {
  const p = CLASSIFIER_SYSTEM_PROMPT;

  it('pins the JSON output contract', () => {
    expect(p).toContain('"label"');
    expect(p).toContain('"confidence"');
    expect(p).toContain('"reason"');
  });

  it('defines all three labels', () => {
    expect(p).toMatch(/INJECTION\s+[—-]/);
    expect(p).toMatch(/DISCLOSURE_PROBE\s+[—-]/);
    expect(p).toMatch(/SAFE\s+[—-]/);
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

  it('carries a few-shot block', () => {
    expect(p).toContain('Examples:');
    // at least 8 example JSON objects
    expect((p.match(/\{"label":/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });

  it('stays within a sane size ceiling', () => {
    expect(p.length).toBeLessThan(4000);
  });
});
