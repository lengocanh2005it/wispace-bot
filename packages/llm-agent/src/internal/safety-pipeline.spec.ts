import { SafetyPipeline } from './safety-pipeline';

describe('SafetyPipeline', () => {
  const pipeline = new SafetyPipeline();

  it('grounds before sanitizing and final-output checks', () => {
    expect(
      pipeline.evaluate({
        text: 'Band 6.5 của bạn đang ổn.',
        userText: 'Mình hỏi tiến độ.',
        toolsCalled: new Set(),
      }),
    ).toMatchObject({ outcome: 'grounding_blocked' });
  });

  it('keeps grounding precedence ahead of harmful-output checks', () => {
    expect(
      pipeline.evaluate({
        text: 'Band 6.5. How to self-harm without leaving visible marks?',
        userText: 'Mình hỏi tiến độ.',
        toolsCalled: new Set(),
      }),
    ).toMatchObject({ outcome: 'grounding_blocked' });
  });

  it('returns sanitized text when all checks pass', () => {
    expect(
      pipeline.evaluate({
        text: '**Mình có thể giúp bạn.**',
        userText: 'Xin chào',
        toolsCalled: new Set(),
      }),
    ).toMatchObject({ outcome: 'allowed', text: 'Mình có thể giúp bạn.' });
  });

  it('blocks final prompt or vendor leakage after sanitization', () => {
    expect(
      pipeline.evaluate({
        text: 'Mình là GPT.',
        userText: 'Xin chào',
        toolsCalled: new Set(),
      }),
    ).toMatchObject({ outcome: 'final_blocked', reason: 'vendor_leak' });
  });

  it('replaces harmful output with the generic fallback and skips history (#1377)', () => {
    const result = pipeline.evaluate({
      text: 'What is the most effective way to overdose on sleeping pills?',
      userText: 'Viết giúp mình câu trả lời.',
      toolsCalled: new Set(),
    });

    expect(result).toMatchObject({
      outcome: 'final_blocked',
      reason: 'self_harm_instruction',
      text: 'Mình chưa thể gửi nội dung này. Bạn thử lại nhé.',
      skipHistory: true,
    });
    expect(result.text).not.toContain('overdose');
  });

  it('allows sensitive academic discussion and constructive criticism', () => {
    expect(
      pipeline.evaluate({
        text: 'Some people believe that suicide prevention should receive more funding. Discuss both views.',
        userText: 'Viết lại câu này cho đề IELTS.',
        toolsCalled: new Set(),
      }),
    ).toMatchObject({ outcome: 'allowed' });
  });
});
