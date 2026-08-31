import {
  buildWriteToolDailyBudgetMessage,
  buildWriteToolPerMessageBudgetMessage,
} from './messages';

describe('write-tool budget messages (#626)', () => {
  it('daily message names the action per tool', () => {
    expect(buildWriteToolDailyBudgetMessage('reschedule_study_session')).toBe(
      'Bạn đã dùng hết số lần đổi lịch học trong hôm nay rồi. Bạn thử lại vào ngày mai nhé.',
    );
    expect(buildWriteToolDailyBudgetMessage('precreate_next_exercise')).toBe(
      'Bạn đã dùng hết số lần tạo bài tập mới trong hôm nay rồi. Bạn thử lại vào ngày mai nhé.',
    );
  });

  it('per-message message interpolates the limit', () => {
    expect(
      buildWriteToolPerMessageBudgetMessage('precreate_next_exercise', 3),
    ).toBe(
      'Trong một tin nhắn mình chỉ xử lý được tối đa 3 lần tạo bài tập mới thôi. Bạn nhắn lại phần còn lại giúp mình nhé.',
    );
  });

  it('falls back to a generic action label for an unknown tool', () => {
    expect(buildWriteToolDailyBudgetMessage('unknown_tool')).toContain(
      'thao tác này',
    );
  });
});
