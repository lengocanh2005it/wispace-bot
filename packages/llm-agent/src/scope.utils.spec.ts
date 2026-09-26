import {
  isObviouslyOffTopic,
  isGreetingOnly,
  isAmbiguousMessage,
  isStopIntent,
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

  it('keeps potential crisis disclosures in the shared prompt path', () => {
    expect(isObviouslyOffTopic('Em đang khủng hoảng tâm lý, muốn tự tử')).toBe(
      false,
    );
    expect(isObviouslyOffTopic('Em cần bác sĩ vì muốn tự tử')).toBe(false);
  });

  it.each([
    'Làm sao để thuộc từ vựng nhanh vậy bạn',
    'Có mẹo nào giúp mình thuộc nhiều từ mới không',
    'Học thuộc lòng bài mẫu có tốt không',
    'Bài này thuộc dạng nào vậy',
    'Mình bị tâm lý phòng thi quá',
    'Có cách nào vượt qua tâm lý sợ viết không',
    'Viết về bóng đá trong Task 2 có được không',
    'Đề bài về game online mình viết sao',
  ])('allows IELTS study and writing request: "%s"', (text) => {
    expect(isObviouslyOffTopic(text)).toBe(false);
  });

  it('still blocks a request for off-topic content without a writing frame', () => {
    expect(isObviouslyOffTopic('Cho mình biết tin về bóng đá world cup')).toBe(
      true,
    );
  });

  it('does not let unrelated writing language bypass the off-topic guard', () => {
    expect(
      isObviouslyOffTopic("I'm writing a report; what crypto should I buy?"),
    ).toBe(true);
  });

  it('does not let an unrelated IELTS mention bypass the off-topic guard', () => {
    expect(
      isObviouslyOffTopic("I'm writing about IELTS; what's the weather today?"),
    ).toBe(true);
  });
});

describe('isGreetingOnly', () => {
  it.each([
    'hello',
    'hi',
    'hey',
    'chào bạn',
    'xin chào',
    'good morning',
    'good afternoon',
    'good evening',
    'chào buổi sáng',
    'chào buổi tối',
    'sup',
    'yo',
    'alo',
    'ok',
    'cảm ơn',
  ])('returns true for "%s"', (text) => {
    expect(isGreetingOnly(text)).toBe(true);
  });

  it.each([
    '',
    'xem lịch học',
    'tiến độ IELTS',
    'Hi, cho mình hỏi cách viết Task 2 với',
    'Chào bạn, mình muốn xem tiến độ học',
    'Hello, can you check my essay please?',
    'Xin chào, lịch học tuần này thế nào ạ',
    'Hey bạn, band mục tiêu của mình là bao nhiêu',
    'chào bạn mình bị áp lực thi quá',
  ])('returns false for "%s"', (text) => {
    expect(isGreetingOnly(text)).toBe(false);
  });
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

  // #959 — the four-character length gate must not catch meaningful short
  // input: stop words, resume words, and score/band references.
  it.each([
    'dừng',
    'thôi',
    'stop',
    'hủy',
    'khoan',
    'không cần nữa',
    'thôi khỏi',
    'thoi khoi',
    'huy!',
  ])('does not treat stop intent "%s" as ambiguous', (text) => {
    expect(isAmbiguousMessage(text)).toBe(false);
    expect(isStopIntent(text)).toBe(true);
  });

  it.each(['tiếp', 'tiếp tục', 'continue'])(
    'does not treat resume word "%s" as ambiguous',
    (text) => {
      expect(isAmbiguousMessage(text)).toBe(false);
    },
  );

  it.each(['7.0', 'band', '6.5?'])(
    'does not treat short score reference "%s" as ambiguous',
    (text) => {
      expect(isAmbiguousMessage(text)).toBe(false);
    },
  );

  it.each(['xyz', 'jjj', '😀', '!!', '...'])(
    'still treats genuinely vague input "%s" as ambiguous',
    (text) => {
      expect(isAmbiguousMessage(text)).toBe(true);
    },
  );
});

describe('isStopIntent (#959 stop acknowledgement)', () => {
  it.each([
    'dừng',
    'dừng lại',
    'thôi',
    'thôi khỏi',
    'thôi đi',
    'stop',
    'hủy',
    'hủy đi',
    'khoan',
    'khoan đã',
    'không cần',
    'không cần nữa',
    'bỏ qua',
  ])('recognizes "%s" as a stop request', (text) => {
    expect(isStopIntent(text)).toBe(true);
  });

  it.each([
    'tiếp',
    'tiếp tục',
    'xem lịch học',
    'band của mình là 7.0',
    'không cần thiết lắm nhưng thôi cứ xem',
    'đúng',
    'dùng',
    'dung',
  ])('does not treat "%s" as a stop request', (text) => {
    expect(isStopIntent(text)).toBe(false);
  });

  it('requires an exact match, not a substring', () => {
    expect(isStopIntent('dừng thử xem sao')).toBe(false);
  });

  it('keeps a bare affirmative out of the ambiguous-message path', () => {
    expect(isAmbiguousMessage('đúng')).toBe(false);
    expect(isStopIntent('dừng')).toBe(true);
  });

  it('does not guess stop intent when a tone-colliding word has no diacritics', () => {
    expect(isStopIntent('dung')).toBe(false);
    expect(isAmbiguousMessage('dung')).toBe(true);
  });
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
    'Mình bị tâm lý phòng thi quá',
    'Có cách nào vượt qua tâm lý sợ viết không',
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
