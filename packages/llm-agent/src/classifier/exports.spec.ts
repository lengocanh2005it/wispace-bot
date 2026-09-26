import {
  CLASSIFIER_LABELS,
  CLASSIFIER_SYSTEM_PROMPT,
  CRISIS_SUPPORT_RESOURCE_MESSAGE,
  buildCrisisSupportHandoffMessage,
  isExtractionReason,
} from '../core';

it('re-exports the classifier prompt and isExtractionReason from the core entrypoint', () => {
  expect(typeof CLASSIFIER_SYSTEM_PROMPT).toBe('string');
  expect(isExtractionReason('system prompt extraction')).toBe(true);
  expect(isExtractionReason('safe question')).toBe(false);
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
