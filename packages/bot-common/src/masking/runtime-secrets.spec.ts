import {
  collectRuntimeSecretValues,
  getRegisteredRuntimeSecretValues,
  registerRuntimeSecrets,
  resetRuntimeSecretsForTests,
} from './runtime-secrets';

describe('runtime secret registry (#632)', () => {
  afterEach(() => resetRuntimeSecretsForTests());

  it('collects configured secret values and drops empty or short values', () => {
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

  it('normalizes and deduplicates registered values', () => {
    registerRuntimeSecrets(['  duplicate-secret-1 ', 'duplicate-secret-1']);

    expect(getRegisteredRuntimeSecretValues()).toEqual(['duplicate-secret-1']);
  });

  it('returns a copy so callers cannot mutate the registry', () => {
    registerRuntimeSecrets(['stable-secret-1']);

    const values = getRegisteredRuntimeSecretValues();
    values.push('caller-secret-2');

    expect(getRegisteredRuntimeSecretValues()).toEqual(['stable-secret-1']);
  });
});
