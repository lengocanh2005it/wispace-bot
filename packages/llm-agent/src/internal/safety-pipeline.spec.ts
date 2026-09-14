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
});
