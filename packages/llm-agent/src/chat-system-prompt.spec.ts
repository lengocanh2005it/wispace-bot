import { CHAT_SYSTEM_PROMPT_CORE } from './chat-system-prompt';

describe('CHAT_SYSTEM_PROMPT_CORE', () => {
  it('keeps the universal instruction sections (English)', () => {
    expect(CHAT_SYSTEM_PROMPT_CORE).toContain('WISPACE scope');
    expect(CHAT_SYSTEM_PROMPT_CORE).toContain('OUT-OF-SCOPE');
    expect(CHAT_SYSTEM_PROMPT_CORE).toContain('When NOT to call tools');
    expect(CHAT_SYSTEM_PROMPT_CORE).toContain('never fabricate');
    expect(CHAT_SYSTEM_PROMPT_CORE).toContain('precreate_next_exercise');
    expect(CHAT_SYSTEM_PROMPT_CORE).toContain('General rules');
    expect(CHAT_SYSTEM_PROMPT_CORE).toContain('Rescheduling');
    expect(CHAT_SYSTEM_PROMPT_CORE).toContain('schedulingMode=explicit');
    expect(CHAT_SYSTEM_PROMPT_CORE).toContain('你好');
  });

  it('keeps the learner-facing Vietnamese strings verbatim', () => {
    expect(CHAT_SYSTEM_PROMPT_CORE).toContain('tiến độ học của mình');
    expect(CHAT_SYSTEM_PROMPT_CORE).toContain(
      'mình cần kiểm tra lại dữ liệu của bạn',
    );
    expect(CHAT_SYSTEM_PROMPT_CORE).toContain('chưa có roadmap');
    expect(CHAT_SYSTEM_PROMPT_CORE).toContain('đã hoàn thành toàn bộ bài');
    expect(CHAT_SYSTEM_PROMPT_CORE).toContain('«đã dời»');
  });

  it('does not name any platform', () => {
    expect(CHAT_SYSTEM_PROMPT_CORE).not.toContain('Messenger');
    expect(CHAT_SYSTEM_PROMPT_CORE).not.toContain('Discord');
    expect(CHAT_SYSTEM_PROMPT_CORE).not.toContain('Zalo');
  });
});
