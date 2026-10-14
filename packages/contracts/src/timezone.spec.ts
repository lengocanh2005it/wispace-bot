import {
  APP_TIMEZONE_ENV_KEY,
  DEFAULT_TIMEZONE,
  LEGACY_TIMEZONE_ENV_KEYS,
  resolveTimezone,
} from './index';

function env(
  values: Record<string, string>,
): (key: string) => undefined | string {
  return (key) => values[key];
}

describe('resolveTimezone', () => {
  it('prefers APP_TIMEZONE over the legacy key', () => {
    expect(
      resolveTimezone(
        env({
          [APP_TIMEZONE_ENV_KEY]: 'Asia/Ho_Chi_Minh',
          [LEGACY_TIMEZONE_ENV_KEYS.chatUsage]: 'Europe/London',
        }),
        LEGACY_TIMEZONE_ENV_KEYS.chatUsage,
      ),
    ).toBe('Asia/Ho_Chi_Minh');
  });

  it('falls back to the legacy key so deployed .env files keep working', () => {
    expect(
      resolveTimezone(
        env({ [LEGACY_TIMEZONE_ENV_KEYS.chatUsage]: 'Europe/London' }),
        LEGACY_TIMEZONE_ENV_KEYS.chatUsage,
      ),
    ).toBe('Europe/London');
  });

  it('falls back to the shared default when nothing is set', () => {
    expect(resolveTimezone(env({}))).toBe(DEFAULT_TIMEZONE);
    expect(
      resolveTimezone(env({}), LEGACY_TIMEZONE_ENV_KEYS.studyReminder),
    ).toBe(DEFAULT_TIMEZONE);
  });

  it('treats a set-but-blank value as unset', () => {
    expect(
      resolveTimezone(
        env({
          [APP_TIMEZONE_ENV_KEY]: '   ',
          [LEGACY_TIMEZONE_ENV_KEYS.llmUsage]: 'Europe/London',
        }),
        LEGACY_TIMEZONE_ENV_KEYS.llmUsage,
      ),
    ).toBe('Europe/London');
  });

  it('ignores a legacy key that belongs to a different feature', () => {
    expect(
      resolveTimezone(
        env({ [LEGACY_TIMEZONE_ENV_KEYS.dataQuality]: 'Europe/London' }),
        LEGACY_TIMEZONE_ENV_KEYS.chatUsage,
      ),
    ).toBe(DEFAULT_TIMEZONE);
  });
});
