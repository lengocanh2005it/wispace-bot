import {
  FALLBACK_DISPLAY_NAME,
  buildGreetingMessage,
  buildLinkSuccessMessage,
  buildSelfIntroMessage,
} from './bot-messages';

describe('buildGreetingMessage', () => {
  it('uses the generic greeting when display name is missing', () => {
    expect(buildGreetingMessage()).toMatch(/^Chào bạn! 👋/);
    expect(buildGreetingMessage(undefined)).toMatch(/^Chào bạn! 👋/);
    expect(buildGreetingMessage('  ')).toMatch(/^Chào bạn! 👋/);
  });

  it('treats the fallback display name sentinel as missing', () => {
    expect(buildGreetingMessage(FALLBACK_DISPLAY_NAME)).toMatch(
      /^Chào bạn! 👋/,
    );
  });

  it('personalizes the greeting when display name is set', () => {
    expect(buildGreetingMessage('Minh')).toMatch(/^Chào Minh! 👋/);
    expect(buildGreetingMessage('  Minh  ')).toMatch(/^Chào Minh! 👋/);
  });

  it('introduces the assistant and invites a natural request', () => {
    const text = buildGreetingMessage();
    expect(text).toContain('trợ lý WISPACE');
    expect(text).toContain('IELTS Writing');
    expect(text).toContain('tạo bài tập mới');
  });
});

describe('buildSelfIntroMessage', () => {
  it('introduces the bot without naming any platform', () => {
    const text = buildSelfIntroMessage();
    expect(text).toContain('WISPACE Bot');
    expect(text).toContain('IELTS Writing');
    expect(text).not.toContain('Messenger');
    expect(text).not.toContain('Discord');
    expect(text).not.toContain('Zalo');
  });
});

describe('buildLinkSuccessMessage', () => {
  it('confirms the account link without naming any platform', () => {
    const text = buildLinkSuccessMessage();
    expect(text).toContain('Tài khoản WISPACE');
    expect(text).toContain('liên kết thành công');
    expect(text).not.toContain('Messenger');
    expect(text).not.toContain('Discord');
    expect(text).not.toContain('Zalo');
  });
});
