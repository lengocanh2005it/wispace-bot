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

    it.each([
      ['chao ban', 'chào bạn'],
      ['xin chao', 'xin chào'],
    ])('treats no-diacritic "%s" like "%s"', (input, accented) => {
      expect(detector.detect(input)).toEqual({
        intent: 'greeting',
        matchedKeyword: detector.detect(accented).matchedKeyword,
      });
    });

    it.each(['chao!', 'xin-chao', 'xin, chao'])(
      'accepts normal punctuation/separators after or between greeting words: "%s"',
      (input) => {
        expect(detector.detect(input).intent).toBe('greeting');
      },
    );

    it('handles case and leading whitespace after canonicalization', () => {
      expect(detector.detect('  ChAo BaN').intent).toBe('greeting');
    });

    it('reuses format-character canonicalization between words', () => {
      expect(detector.detect('xin\u00adchao').intent).toBe('greeting');
    });

    it.each([
      'Hi, cho mình hỏi cách viết Task 2 với',
      'Chào bạn, mình muốn xem tiến độ học',
      'Hello, can you check my essay please?',
      'Xin chào, lịch học tuần này thế nào ạ',
      'Hey bạn, band mục tiêu của mình là bao nhiêu',
      'chào bạn mình bị áp lực thi quá',
    ])('does not swallow content after a greeting: "%s"', (input) => {
      expect(detector.detect(input)).toEqual({ intent: 'unknown' });
    });
  });

  describe('self-intro detection', () => {
    it.each([
      'bạn là ai',
      'bạn là ai vậy',
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

    it('keeps self-intro precedence when custom keywords overlap', () => {
      const overlapping = new IntentDetector({
        greetingKeywords: ['bạn'],
        selfIntroKeywords: ['bạn là ai'],
      });

      expect(overlapping.detect('ban la ai')).toEqual({
        intent: 'self_intro',
        matchedKeyword: 'bạn là ai',
      });
    });

    it.each([
      ['ban la ai', 'bạn là ai'],
      ['ban ten gi', 'bạn tên gì'],
    ])('treats no-diacritic "%s" like "%s"', (input, accented) => {
      expect(detector.detect(input)).toEqual({
        intent: 'self_intro',
        matchedKeyword: detector.detect(accented).matchedKeyword,
      });
    });

    it('accepts punctuation after a no-diacritic self-introduction', () => {
      expect(detector.detect('ban la ai?').intent).toBe('self_intro');
    });

    it.each([
      'giới thiệu về cấu trúc Task 1 giúp mình',
      'giới thiệu bài mẫu band 7 cho mình',
      'bạn là ai, giúp mình kiểm tra bài viết',
    ])('does not swallow content after self-intro wording: "%s"', (input) => {
      expect(detector.detect(input)).toEqual({ intent: 'unknown' });
    });
  });

  describe('unknown intent', () => {
    it.each([
      'minh muon xem tien do hoc tap',
      'lich hoc ngay mai',
      'diem so cua minh',
      'lam the nao de viet Task 2',
      'Cho mình hỏi cách viết Task 2',
    ])('detects "%s" as unknown', (input) => {
      expect(detector.detect(input).intent).toBe('unknown');
    });
  });

  describe('custom config', () => {
    it('canonicalizes custom greeting and self-introduction keywords', () => {
      const custom = new IntentDetector({
        greetingKeywords: ['chào bạn'],
        selfIntroKeywords: ['bạn là ai'],
      });
      expect(custom.detect('chao ban')).toEqual({
        intent: 'greeting',
        matchedKeyword: 'chào bạn',
      });
      expect(custom.detect('ban la ai')).toEqual({
        intent: 'self_intro',
        matchedKeyword: 'bạn là ai',
      });
      expect(custom.detect('hi').intent).toBe('unknown');
    });

    it.each(['chaoban', 'banlaai', 'history'])(
      'does not match a keyword inside a longer token: "%s"',
      (input) => {
        expect(detector.detect(input).intent).toBe('unknown');
      },
    );
  });
});
