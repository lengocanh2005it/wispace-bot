import { CHAT_SYSTEM_PROMPT_CORE } from '../chat-system-prompt';
import {
  checkFinalOutputSafety,
  SYSTEM_PROMPT_LEAK_MARKERS,
} from './final-output.utils';

describe('checkFinalOutputSafety', () => {
  it('flags a reply leaking the system-prompt opening', () => {
    const result = checkFinalOutputSafety(
      'You are the WISPACE assistant — an IELTS Writing coach.',
    );
    expect(result).toEqual({ unsafe: true, reason: 'prompt_leak' });
  });

  it('flags a reply leaking an instruction section header', () => {
    const result = checkFinalOutputSafety(
      'Xin chào! When NOT to call tools: greetings only.',
    );
    expect(result).toEqual({ unsafe: true, reason: 'prompt_leak' });
  });

  it('flags credential-shaped content (sk- key)', () => {
    const result = checkFinalOutputSafety(
      'Đây là key của mình: sk-1234567890abcdef1234567890abcdef',
    );
    expect(result).toEqual({ unsafe: true, reason: 'credential_leak' });
  });

  it('flags credential-shaped content (Bearer token)', () => {
    const result = checkFinalOutputSafety(
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
    );
    expect(result).toEqual({ unsafe: true, reason: 'credential_leak' });
  });

  it('flags credential-shaped content (api_key assignment)', () => {
    const result = checkFinalOutputSafety('api_key=supersecretvalue12345');
    expect(result).toEqual({ unsafe: true, reason: 'credential_leak' });
  });

  it('keeps a normal IELTS reply safe', () => {
    const result = checkFinalOutputSafety(
      'Bạn cần luyện thêm Task 1 nhé. Hôm nay bạn có buổi học lúc 19:00.',
    );
    expect(result.unsafe).toBe(false);
  });

  it('keeps URLs and file paths safe', () => {
    const result = checkFinalOutputSafety(
      'Báo cáo của bạn tại https://wispace.example/reports/123 nhé.',
    );
    expect(result.unsafe).toBe(false);
  });

  describe('vendor / model identifier leak (#625)', () => {
    const leaks = [
      'Mình chạy trên GPT-4o của OpenAI.',
      'Mình là ChatGPT nhé.',
      'I am GPT, here to help.',
      'Được xây dựng bằng Claude 3.5 Sonnet.',
      'This assistant is powered by Anthropic.',
      'Provider của mình là OpenRouter.',
      'Mình dùng Gemini Pro nhé.',
      'temperature=0.7, top_p: 0.9',
      'system fingerprint: fp_abc123',
      'Knowledge cutoff của mình là 2024.',
    ];
    it.each(leaks)('flags: %s', (text) => {
      const result = checkFinalOutputSafety(text);
      expect(result).toEqual({ unsafe: true, reason: 'vendor_leak' });
    });

    it('keeps an IELTS essay that merely discusses AI safe', () => {
      const result = checkFinalOutputSafety(
        'Trong bài Task 2 về công nghệ, bạn có thể nêu lợi ích của AI và tự động hoá.',
      );
      expect(result.unsafe).toBe(false);
    });

    it('does not flag the standard non-disclosure reply itself', () => {
      const result = checkFinalOutputSafety(
        'Mình là trợ lý AI của WISPACE, đồng hành cùng bạn luyện IELTS Writing — theo dõi tiến độ, lịch học và cách làm Task 1/2. Bạn muốn mình hỗ trợ phần nào của Writing không?',
      );
      expect(result.unsafe).toBe(false);
    });
  });
});

describe('SYSTEM_PROMPT_LEAK_MARKERS sync guard (#165)', () => {
  it('every marker still exists in CHAT_SYSTEM_PROMPT_CORE — a prompt edit must update the markers deliberately', () => {
    for (const marker of SYSTEM_PROMPT_LEAK_MARKERS) {
      expect(CHAT_SYSTEM_PROMPT_CORE).toContain(marker);
    }
  });
});
