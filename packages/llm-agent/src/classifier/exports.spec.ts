import {
  CLASSIFIER_LABELS,
  CLASSIFIER_SYSTEM_PROMPT,
  CRISIS_SUPPORT_RESOURCE_MESSAGE,
  buildCrisisSupportHandoffMessage,
  isDistressExpression,
} from '../index';

it('re-exports the classifier prompt and isDistressExpression from the package root', () => {
  expect(typeof CLASSIFIER_SYSTEM_PROMPT).toBe('string');
  expect(isDistressExpression('mình chán quá muốn bỏ cuộc')).toBe(true);
  expect(isDistressExpression('cách viết Task 1')).toBe(false);
});

it('re-exports the canonical classifier labels registry (#1054)', () => {
  expect(CLASSIFIER_LABELS).toEqual([
    'SAFE',
    'INJECTION',
    'DISCLOSURE_PROBE',
    'ABUSE',
    'CRISIS',
  ]);
  expect(
    Object.isFrozen(CLASSIFIER_LABELS) || Array.isArray(CLASSIFIER_LABELS),
  ).toBe(true);
});

it('re-exports the crisis support-handoff helpers (#1054 / #982)', () => {
  expect(CRISIS_SUPPORT_RESOURCE_MESSAGE).toContain(
    'Tổng đài Quốc gia Bảo vệ Trẻ em 111',
  );
  expect(buildCrisisSupportHandoffMessage()).toBe(
    `Mình rất tiếc vì bạn đang trải qua điều này. ${CRISIS_SUPPORT_RESOURCE_MESSAGE}`,
  );
});
