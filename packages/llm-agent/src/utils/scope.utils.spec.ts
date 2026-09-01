import {
  isObviouslyOffTopic,
  isGreetingOnly,
  isAmbiguousMessage,
  isDistressExpression,
} from './scope.utils';

describe('isObviouslyOffTopic', () => {
  it.each(['', '   ', 'chào bạn', 'hello', 'ok'])(
    'returns false for "%s"',
    (text) => {
      expect(isObviouslyOffTopic(text)).toBe(false);
    },
  );

  it.each([
    'thời tiết hôm nay ra sao',
    'bóng đá world cup năm nay',
    'bitcoin giá bao nhiêu hiện tại',
    'nấu ăn công thức cơm tấm ngon',
    'python code tutorial for beginners',
  ])('returns true for "%s"', (text) => {
    expect(isObviouslyOffTopic(text)).toBe(true);
  });

  it('returns false for short ambiguous messages', () => {
    expect(isObviouslyOffTopic('cái đó')).toBe(false);
  });

  it.each(['thời tiết', 'thoi tiet', 'bóng đá'])(
    'recognizes short Vietnamese off-topic text: "%s"',
    (text) => {
      expect(isObviouslyOffTopic(text)).toBe(true);
    },
  );

  it('keeps in-scope no-diacritic text allowed', () => {
    expect(isObviouslyOffTopic('xem lich hoc')).toBe(false);
  });
});

describe('isGreetingOnly', () => {
  it.each(['hello', 'hi', 'chào bạn', 'xin chào', 'ok', 'cảm ơn'])(
    'returns true for "%s"',
    (text) => {
      expect(isGreetingOnly(text)).toBe(true);
    },
  );

  it.each(['', 'xem lịch học', 'tiến độ IELTS'])(
    'returns false for "%s"',
    (text) => {
      expect(isGreetingOnly(text)).toBe(false);
    },
  );
});

describe('isAmbiguousMessage', () => {
  it.each(['', '   ', '\t\n'])(
    'returns true for empty/whitespace "%s"',
    (text) => {
      expect(isAmbiguousMessage(text)).toBe(true);
    },
  );

  it.each(['abc???', '!!!', '???', '---___', '###$$$'])(
    'returns true for random characters "%s"',
    (text) => {
      expect(isAmbiguousMessage(text)).toBe(true);
    },
  );

  it.each(['x', 'q', 'z', 'l', 'k'])(
    'returns true for single letter typo "%s"',
    (text) => {
      expect(isAmbiguousMessage(text)).toBe(true);
    },
  );

  it.each([
    'thứ',
    'bài',
    'cái đó',
    'học gì',
    'cho xin',
    'gì vậy',
    'sao thế',
    'thì sao',
    'ngày mai',
    'mai',
    'tuần sau',
    'sáng',
    'chiều',
  ])('returns true for meaningless Vietnamese fragment "%s"', (text) => {
    expect(isAmbiguousMessage(text)).toBe(true);
  });

  it('normalizes punctuation and no-diacritic typos before classifying fragments', () => {
    expect(isAmbiguousMessage('Hoc gi?')).toBe(true);
    expect(isAmbiguousMessage('ngay mai!!!')).toBe(true);
    expect(isAmbiguousMessage('hoc gii')).toBe(true);
    expect(isAmbiguousMessage('lichh')).toBe(true);
    expect(isAmbiguousMessage('lich hoc')).toBe(false);
  });

  it.each([
    'hello',
    'chào bạn',
    'xin chào',
    'hi bot',
    'cảm ơn',
    'ok',
    'vâng',
    'ừ',
    'dạ',
  ])('returns false for greeting/acknowledgment "%s"', (text) => {
    expect(isAmbiguousMessage(text)).toBe(false);
  });

  it.each([
    'tiến độ học IELTS của mình',
    'lịch học tuần tới',
    'điểm band hiện tại',
    'đổi lịch học sang thứ 7',
    'cách luyện Task 1',
  ])('returns false for clear message "%s"', (text) => {
    expect(isAmbiguousMessage(text)).toBe(false);
  });

  it.each(['mình muốn hỏi gì đó', 'có tin gì không', 'hỏi một chút'])(
    'returns false for vague but answerable message "%s"',
    (text) => {
      expect(isAmbiguousMessage(text)).toBe(false);
    },
  );
});

describe('isDistressExpression (#598 study-stress rescue)', () => {
  it.each([
    'áp lực thi quá',
    'áp lực qua',
    'hoc mai khong len, chan qua',
    'mình chán quá',
    'muốn bỏ cuộc',
    'bo cuoc thoi',
    'học mãi không lên band',
    'mệt quá không học nổi',
    'nan qua di',
    'thất vọng điểm quá',
    'so stressed about the exam',
    'i feel burnt out',
  ])('detects study distress: "%s"', (text) => {
    expect(isDistressExpression(text)).toBe(true);
  });

  it.each([
    'xem lịch học tuần tới',
    'tiến độ IELTS của mình',
    'thời tiết hôm nay',
    'bóng đá world cup',
    'luyện Task 2 thế nào',
    'band của mình bao nhiêu',
  ])('does not flag in-scope or off-topic text: "%s"', (text) => {
    expect(isDistressExpression(text)).toBe(false);
  });

  it('does not flag mild neutral mentions of study words', () => {
    expect(isDistressExpression('học từ vựng mỗi ngày')).toBe(false);
  });

  describe('rescue from pre-LLM gates', () => {
    it('short distress messages are not ambiguous', () => {
      expect(isAmbiguousMessage('áp lực thi quá')).toBe(false);
      expect(isAmbiguousMessage('muốn bỏ cuộc')).toBe(false);
    });

    it('distress mentioning off-topic vocab (bác sĩ/tâm lý) is not off-topic', () => {
      expect(isObviouslyOffTopic('áp lực quá muốn đi khám tâm lý')).toBe(false);
    });

    it('plain off-topic is still off-topic (rescue does not widen scope)', () => {
      expect(isObviouslyOffTopic('thời tiết hôm nay ra sao')).toBe(true);
      expect(isAmbiguousMessage('mai')).toBe(true);
    });
  });
});
