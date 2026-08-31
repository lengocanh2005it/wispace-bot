import {
  redactSecrets,
  registerRuntimeSecrets,
  resetRuntimeSecretsForTests,
  collectRuntimeSecretValues,
} from './secret-redaction.utils';

describe('redactSecrets (#632)', () => {
  afterEach(() => resetRuntimeSecretsForTests());

  it('redacts credential shapes', () => {
    const { text, redacted } = redactSecrets(
      'call failed with Authorization: Bearer abcdef1234567890abcd at /v1/goals',
    );
    expect(redacted).toBe(true);
    expect(text).not.toContain('abcdef1234567890abcd');
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('/v1/goals');
  });

  it('redacts runtime-registered secret values (exact match)', () => {
    registerRuntimeSecrets(['super-internal-key-42', 'sk-live-runtime-key-99']);
    const { text, redacted } = redactSecrets(
      'auth used super-internal-key-42 against the goals API',
    );
    expect(redacted).toBe(true);
    expect(text).not.toContain('super-internal-key-42');
    expect(text).toContain('[REDACTED]');
  });

  it('leaves clean text untouched (redacted=false)', () => {
    const { text, redacted } = redactSecrets('Band speaking của bạn là 6.5');
    expect(redacted).toBe(false);
    expect(text).toBe('Band speaking của bạn là 6.5');
  });

  it('ignores registered values shorter than 8 chars', () => {
    registerRuntimeSecrets(['true', 'ok']);
    const { text, redacted } = redactSecrets('this is true and ok');
    expect(redacted).toBe(false);
    expect(text).toBe('this is true and ok');
  });

  it('ignores empty registered values', () => {
    registerRuntimeSecrets(['', '   ']);
    const { redacted } = redactSecrets('nothing to see');
    expect(redacted).toBe(false);
  });

  it('deduplicates registered values', () => {
    registerRuntimeSecrets(['duplicate-secret-1', 'duplicate-secret-1']);
    const { text, redacted } = redactSecrets('value duplicate-secret-1 here');
    expect(redacted).toBe(true);
    expect(text).not.toContain('duplicate-secret-1');
  });
});

describe('collectRuntimeSecretValues (#632)', () => {
  afterEach(() => resetRuntimeSecretsForTests());

  it('collects configured secret env values, dropping empty/short ones', () => {
    const values = collectRuntimeSecretValues(
      (key) =>
        ({
          OPENAI_API_KEY: 'sk-collect-1234567890',
          INTERNAL_API_KEY: 'internal-ops-key-9876',
          DB_PASSWORD: 'short',
          MESSENGER_PAGE_TOKEN: '',
          LLM_PROVIDER_FAILOVER_ORDER: 'openai',
        })[key],
    );

    expect(values).toContain('sk-collect-1234567890');
    expect(values).toContain('internal-ops-key-9876');
    expect(values).not.toContain('short');
    expect(values).not.toContain('');
    expect(values).not.toContain('openai');
  });
});
