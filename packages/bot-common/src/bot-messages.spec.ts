import {
  FALLBACK_DISPLAY_NAME,
  GREETING_VARIANTS,
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

  it('picks one of the predefined variants', () => {
    const text = buildGreetingMessage();
    expect(
      GREETING_VARIANTS.some((variant) => text === `Chào bạn! 👋 ${variant}`),
    ).toBe(true);
  });

  it('rotates through variants via the injected random', () => {
    expect(buildGreetingMessage('Minh', () => 0)).toBe(
      `Chào Minh! 👋 ${GREETING_VARIANTS[0]}`,
    );
    expect(buildGreetingMessage('Minh', () => 0.999)).toBe(
      `Chào Minh! 👋 ${GREETING_VARIANTS[GREETING_VARIANTS.length - 1]}`,
    );
  });

  it('keeps the assistant intro and invites a natural request', () => {
    for (const variant of GREETING_VARIANTS) {
      expect(variant).toContain('WISPACE');
      expect(variant).toContain('IELTS Writing');
    }
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
