import { validateInternalApiKeyEnv } from './internal-api-key-env';

const INTERNAL_API_KEY_ENV = 'INTERNAL_API_KEY';

describe('validateInternalApiKeyEnv', () => {
  it('passes a configured key through unchanged', () => {
    const config = {
      [INTERNAL_API_KEY_ENV]: 'internal-ops-key-42',
      DB_HOST: 'x',
    };

    expect(validateInternalApiKeyEnv(config)).toBe(config);
  });

  it('throws when the key is absent so the process cannot boot healthy', () => {
    expect(() => validateInternalApiKeyEnv({})).toThrow(
      /INTERNAL_API_KEY is required/,
    );
  });

  it('throws when the key is empty or whitespace', () => {
    expect(() =>
      validateInternalApiKeyEnv({ [INTERNAL_API_KEY_ENV]: '   ' }),
    ).toThrow(/INTERNAL_API_KEY is required/);
  });

  it('throws when the key is too short to be a usable credential', () => {
    expect(() =>
      validateInternalApiKeyEnv({ [INTERNAL_API_KEY_ENV]: 'short' }),
    ).toThrow(/at least 8 characters/);
  });
});
