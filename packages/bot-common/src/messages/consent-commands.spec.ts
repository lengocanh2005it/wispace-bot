import { normalizeConsentText, parseConsentCommand } from './consent-commands';

describe('parseConsentCommand (#596)', () => {
  it.each([
    ['bật báo cáo', { feature: 'report', action: 'enable' }],
    ['Bật Báo Cáo', { feature: 'report', action: 'enable' }],
    ['dang ky bao cao', { feature: 'report', action: 'enable' }],
    ['tắt báo cáo', { feature: 'report', action: 'disable' }],
    ['hủy báo cáo', { feature: 'report', action: 'disable' }],
    ['dừng báo cáo', { feature: 'report', action: 'disable' }],
    ['bật nhắc học', { feature: 'reminder', action: 'enable' }],
    ['bật nhắc', { feature: 'reminder', action: 'enable' }],
    ['tắt nhắc học', { feature: 'reminder', action: 'disable' }],
    ['hủy nhắc học', { feature: 'reminder', action: 'disable' }],
    // Diacritics-free and whitespace-normalized forms.
    ['  BAT   BAO   CAO  ', { feature: 'report', action: 'enable' }],
    ['Tắt nhắc học.', { feature: 'reminder', action: 'disable' }],
  ])('parses "%s" as %j', (input, expected) => {
    expect(parseConsentCommand(input)).toEqual(expected);
  });

  it.each([
    'bật báo cáo giùm mình nhé',
    'cho mình xin báo cáo',
    'tắt đi',
    '',
    'hello',
    'bật',
    'nhắc học',
  ])('returns null for non-command "%s"', (input) => {
    expect(parseConsentCommand(input)).toBeNull();
  });

  it('normalizes diacritics deterministically', () => {
    expect(normalizeConsentText('Tắt Báo Cáo')).toBe('tat bao cao');
    expect(normalizeConsentText('ĐĂNG KÝ NHẮC HỌC')).toBe('dang ky nhac hoc');
  });
});
