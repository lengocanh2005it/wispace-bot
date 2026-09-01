import { CLASSIFIER_SYSTEM_PROMPT, isDistressExpression } from '../index';

it('re-exports the classifier prompt and isDistressExpression from the package root', () => {
  expect(typeof CLASSIFIER_SYSTEM_PROMPT).toBe('string');
  expect(isDistressExpression('mình chán quá muốn bỏ cuộc')).toBe(true);
  expect(isDistressExpression('cách viết Task 1')).toBe(false);
});
