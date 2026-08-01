import { IntentDetector } from './intent-detector';

describe('IntentDetector', () => {
  const detector = new IntentDetector();

  describe('greeting detection', () => {
    it.each([
      'hi',
      'Hi',
      'HI',
      'hello',
      'Hello',
      'chào',
      'Chào bạn',
      'xin chào',
      'hey',
      'good morning',
      'chào buổi sáng',
      'sup',
      'yo',
    ])('detects "%s" as greeting', (input) => {
      expect(detector.detect(input).intent).toBe('greeting');
    });

    it('detects greeting with leading whitespace', () => {
      expect(detector.detect('  hi').intent).toBe('greeting');
    });

    it('does not detect "history" as greeting', () => {
      expect(detector.detect('history of my scores').intent).toBe('unknown');
    });
  });

  describe('self-intro detection', () => {
    it.each([
      'bạn là ai',
      'bạn tên gì',
      'bạn làm gì',
      'tên bạn',
      'giới thiệu',
      'bạn là gì',
      'mình là ai',
    ])('detects "%s" as self_intro', (input) => {
      expect(detector.detect(input).intent).toBe('self_intro');
    });

    it('self_intro takes priority over greeting', () => {
      expect(detector.detect('bạn là ai').intent).toBe('self_intro');
    });
  });

  describe('unknown intent', () => {
    it.each([
      'minh muon xem tien do hoc tap',
      'lich hoc ngay mai',
      'diem so cua minh',
      'lam the nao de viet Task 2',
    ])('detects "%s" as unknown', (input) => {
      expect(detector.detect(input).intent).toBe('unknown');
    });
  });

  describe('custom config', () => {
    it('uses custom greeting keywords', () => {
      const custom = new IntentDetector({
        greetingKeywords: ['chao ban'],
      });
      expect(custom.detect('chao ban').intent).toBe('greeting');
      expect(custom.detect('hi').intent).toBe('unknown');
    });
  });
});
