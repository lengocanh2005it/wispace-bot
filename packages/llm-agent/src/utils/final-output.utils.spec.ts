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
});

describe('SYSTEM_PROMPT_LEAK_MARKERS sync guard (#165)', () => {
  it('every marker still exists in CHAT_SYSTEM_PROMPT_CORE — a prompt edit must update the markers deliberately', () => {
    for (const marker of SYSTEM_PROMPT_LEAK_MARKERS) {
      expect(CHAT_SYSTEM_PROMPT_CORE).toContain(marker);
    }
  });
});
