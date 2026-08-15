import { CHAT_SYSTEM_PROMPT_CORE } from './chat-system-prompt';

describe('CHAT_SYSTEM_PROMPT_CORE', () => {
  it('keeps the universal rule sections', () => {
    expect(CHAT_SYSTEM_PROMPT_CORE).toContain('Phạm vi WISPACE');
    expect(CHAT_SYSTEM_PROMPT_CORE).toContain('Câu NGOÀI phạm vi');
    expect(CHAT_SYSTEM_PROMPT_CORE).toContain('KHÔNG được gọi tool');
    expect(CHAT_SYSTEM_PROMPT_CORE).toContain('tuyệt đối không bịa');
    expect(CHAT_SYSTEM_PROMPT_CORE).toContain('precreate_next_exercise');
    expect(CHAT_SYSTEM_PROMPT_CORE).toContain('Quy tắc chung');
    expect(CHAT_SYSTEM_PROMPT_CORE).toContain('Đổi / dời lịch học');
    expect(CHAT_SYSTEM_PROMPT_CORE).toContain('schedulingMode=explicit');
    expect(CHAT_SYSTEM_PROMPT_CORE).toContain('你好');
  });

  it('does not name any platform', () => {
    expect(CHAT_SYSTEM_PROMPT_CORE).not.toContain('Messenger');
    expect(CHAT_SYSTEM_PROMPT_CORE).not.toContain('Discord');
    expect(CHAT_SYSTEM_PROMPT_CORE).not.toContain('Zalo');
  });
});
