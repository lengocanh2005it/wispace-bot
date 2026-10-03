import { collectLlmStartupViolations } from './startup-validation';

/**
 * A release-image baseline: NODE_ENV=production is baked into the image
 * (deploy/Dockerfile.bot), and the model allowlist is provider-prefixed.
 */
const VALID_LLM_ENV = {
  NODE_ENV: 'production',
  OPENAI_API_KEY: 'sk-proj-valid-key',
  OPENAI_MODEL: 'gpt-5.4',
  LLM_ALLOWED_MODELS: 'openai:gpt-5.4',
  LLM_ALLOWED_BASE_URLS: 'api.openai.com',
};

const MESSENGER_REPORT = {
  producerName: 'messenger report',
  concurrencyEnvKey: 'REPORT_SEND_CONCURRENCY',
};

const DISCORD_REPORT = {
  producerName: 'discord report',
  concurrencyEnvKey: 'DISCORD_REPORT_SEND_CONCURRENCY',
};

describe('collectLlmStartupViolations — background producer capacity', () => {
  it('reports a producer concurrency above the derived capacity, naming the key, the configured value and the capacity', () => {
    const violations = collectLlmStartupViolations(
      { ...VALID_LLM_ENV, REPORT_SEND_CONCURRENCY: '5' },
      [MESSENGER_REPORT],
    );

    expect(violations).toEqual([
      {
        scope: 'REPORT_SEND_CONCURRENCY',
        message:
          'messenger report concurrency 5 exceeds background admission capacity 3',
      },
    ]);
  });

  it('accepts a producer concurrency equal to the capacity', () => {
    const violations = collectLlmStartupViolations(
      { ...VALID_LLM_ENV, REPORT_SEND_CONCURRENCY: '3' },
      [MESSENGER_REPORT],
    );

    expect(violations).toEqual([]);
  });

  it('derives the capacity from the admission env rather than from a stored constant', () => {
    // Documented capacity = slots + floor(waitMs * slots / requestTimeoutMs)
    // = 3 + floor(120000 * 3 / 30000) = 3 + 12 = 15, so 5 is admissible here
    // while it is not against the default 1500ms wait budget (capacity 3).
    const violations = collectLlmStartupViolations(
      {
        ...VALID_LLM_ENV,
        REPORT_SEND_CONCURRENCY: '5',
        LLM_BACKGROUND_ADMISSION_WAIT_MS: '120000',
      },
      [MESSENGER_REPORT],
    );

    expect(violations).toEqual([]);
  });

  it('reads a fractional override the same way the producer does', () => {
    const violations = collectLlmStartupViolations(
      { ...VALID_LLM_ENV, REPORT_SEND_CONCURRENCY: '5.9' },
      [MESSENGER_REPORT],
    );

    expect(violations).toEqual([
      {
        scope: 'REPORT_SEND_CONCURRENCY',
        message:
          'messenger report concurrency 5 exceeds background admission capacity 3',
      },
    ]);
  });

  it('reports each offending producer separately so one does not hide the next', () => {
    const violations = collectLlmStartupViolations(
      {
        ...VALID_LLM_ENV,
        REPORT_SEND_CONCURRENCY: '5',
        DISCORD_REPORT_SEND_CONCURRENCY: '9',
      },
      [MESSENGER_REPORT, DISCORD_REPORT],
    );

    expect(violations.map((violation) => violation.scope)).toEqual([
      'REPORT_SEND_CONCURRENCY',
      'DISCORD_REPORT_SEND_CONCURRENCY',
    ]);
  });

  it('does not report a capacity violation when LLM execution is disabled, mirroring the warning the app emits', () => {
    const violations = collectLlmStartupViolations(
      {
        ...VALID_LLM_ENV,
        LLM_EXECUTION_ENABLED: 'false',
        REPORT_SEND_CONCURRENCY: '5',
      },
      [MESSENGER_REPORT],
    );

    expect(violations).toEqual([]);
  });
});

describe('collectLlmStartupViolations — provider configuration', () => {
  it('reports a credential the provider validator rejects, naming the provider and the env key', () => {
    const violations = collectLlmStartupViolations(
      { ...VALID_LLM_ENV, OPENAI_API_KEY: 'sk-or-v1-openrouter-credential' },
      [],
    );

    expect(violations).toEqual([
      {
        scope: 'LLM provider configuration',
        message:
          'LLM provider openai has an invalid API key format (OPENAI_API_KEY); expected an OpenAI sk- key',
      },
    ]);
  });

  it('never echoes the credential value into the report', () => {
    const violations = collectLlmStartupViolations(
      { ...VALID_LLM_ENV, OPENAI_API_KEY: 'sk-or-v1-openrouter-credential' },
      [],
    );

    expect(violations[0]?.message).not.toContain(
      'sk-or-v1-openrouter-credential',
    );
  });

  it('reports nothing for a credential the provider accepts', () => {
    expect(collectLlmStartupViolations(VALID_LLM_ENV, [])).toEqual([]);
  });

  it('reports a base URL outside the approved allowlist', () => {
    const violations = collectLlmStartupViolations(
      { ...VALID_LLM_ENV, OPENAI_BASE_URL: 'https://evil.example.com/v1' },
      [],
    );

    expect(violations).toEqual([
      {
        scope: 'LLM provider configuration',
        message: expect.stringContaining('LLM_ALLOWED_BASE_URLS'),
      },
    ]);
  });

  it('reports the provider and the producer violation in one pass', () => {
    const violations = collectLlmStartupViolations(
      {
        ...VALID_LLM_ENV,
        OPENAI_API_KEY: 'sk-or-v1-openrouter-credential',
        REPORT_SEND_CONCURRENCY: '5',
      },
      [MESSENGER_REPORT],
    );

    expect(violations.map((violation) => violation.scope)).toEqual([
      'LLM provider configuration',
      'REPORT_SEND_CONCURRENCY',
    ]);
  });

  it('does not judge the provider while LLM execution is explicitly disabled, mirroring the application', () => {
    const violations = collectLlmStartupViolations(
      {
        ...VALID_LLM_ENV,
        LLM_EXECUTION_ENABLED: 'false',
        OPENAI_API_KEY: 'sk-or-v1-openrouter-credential',
      },
      [],
    );

    expect(violations).toEqual([]);
  });
});

describe('collectLlmStartupViolations — execution constraints', () => {
  it('reports an out-of-range shared provider attempt budget', () => {
    const violations = collectLlmStartupViolations(
      { ...VALID_LLM_ENV, LLM_MAX_TOTAL_PROVIDER_ATTEMPTS: '99' },
      [],
    );

    expect(violations).toEqual([
      {
        scope: 'LLM execution configuration',
        message:
          'LLM_MAX_TOTAL_PROVIDER_ATTEMPTS must be an integer from 1 to 8',
      },
    ]);
  });

  it('reports the aggregate concurrency limit enabled without Redis', () => {
    const violations = collectLlmStartupViolations(
      { ...VALID_LLM_ENV, LLM_GLOBAL_CONCURRENCY_ENABLED: 'true' },
      [],
    );

    expect(violations).toEqual([
      {
        scope: 'LLM_GLOBAL_CONCURRENCY_ENABLED',
        message: expect.stringContaining('requires a Redis client'),
      },
    ]);
  });

  it('accepts the aggregate concurrency limit when Redis is enabled', () => {
    const violations = collectLlmStartupViolations(
      {
        ...VALID_LLM_ENV,
        LLM_GLOBAL_CONCURRENCY_ENABLED: 'true',
        REDIS_ENABLED: 'true',
      },
      [],
    );

    expect(violations).toEqual([]);
  });

  it('stops before judging producers when the execution config itself is unusable', () => {
    const violations = collectLlmStartupViolations(
      { ...VALID_LLM_ENV, LLM_MAX_TOTAL_PROVIDER_ATTEMPTS: '99' },
      [MESSENGER_REPORT],
    );

    expect(violations.map((violation) => violation.scope)).toEqual([
      'LLM execution configuration',
    ]);
  });
});
