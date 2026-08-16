import { pinFactsToReply, buildExerciseUrlFact } from './pinned-facts';

describe('pinFactsToReply', () => {
  it('appends facts the model omitted, in order', () => {
    expect(
      pinFactsToReply('Đã tạo bài tập mới cho bạn.', [
        {
          key: 'exercise_url',
          text: 'Mở bài tập tại đây: https://example.com/1',
        },
        { key: 'reminder', text: 'Buổi học tiếp theo lúc 19:00.' },
      ]),
    ).toBe(
      'Đã tạo bài tập mới cho bạn.\n\n' +
        'Mở bài tập tại đây: https://example.com/1\n\n' +
        'Buổi học tiếp theo lúc 19:00.',
    );
  });

  it('does not duplicate a fact the model already included', () => {
    const url = 'https://example.com/1';
    expect(
      pinFactsToReply(`Xong rồi. Mở bài tập tại đây: ${url}`, [
        buildExerciseUrlFact(url),
      ]),
    ).toBe(`Xong rồi. Mở bài tập tại đây: ${url}`);
  });

  it('returns the trimmed text when there are no facts', () => {
    expect(pinFactsToReply('  Xong rồi.  ', [])).toBe('Xong rồi.');
  });

  it('returns the fact alone when the reply is empty', () => {
    expect(pinFactsToReply('', [buildExerciseUrlFact('https://e.com/2')])).toBe(
      'Mở bài tập tại đây: https://e.com/2',
    );
  });
});
