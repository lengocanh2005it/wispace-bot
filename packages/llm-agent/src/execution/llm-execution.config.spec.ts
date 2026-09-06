import {
  buildLlmExecutionConfig,
  LLM_EXECUTION_DEFAULTS,
} from './llm-execution.config';

describe('buildLlmExecutionConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LLM_EXECUTION_ENABLED;
    delete process.env.LLM_MAX_CONCURRENT;
    delete process.env.LLM_GLOBAL_MAX_CONCURRENT;
    delete process.env.LLM_OPENAI_RETRY_MAX_ATTEMPTS;
    delete process.env.LLM_OPENAI_RETRY_BACKOFF_MS;
    delete process.env.LLM_OPENAI_RETRY_MAX_DELAY_MS;
    delete process.env.LLM_REQUEST_TIMEOUT_MS;
    delete process.env.LLM_RETRY_PER_ATTEMPT_TIMEOUT_MS;
    delete process.env.LLM_GLOBAL_CONCURRENCY_ENABLED;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns documented defaults when no env vars set', () => {
    const config = buildLlmExecutionConfig();
    expect(config).toEqual({
      enabled: LLM_EXECUTION_DEFAULTS.enabled,
      maxConcurrent: LLM_EXECUTION_DEFAULTS.maxConcurrent,
      maxQueueDepth: LLM_EXECUTION_DEFAULTS.maxQueueDepth,
      chatAdmissionWaitMs: LLM_EXECUTION_DEFAULTS.chatAdmissionWaitMs,
      backgroundAdmissionWaitMs:
        LLM_EXECUTION_DEFAULTS.backgroundAdmissionWaitMs,
      globalMaxConcurrent: LLM_EXECUTION_DEFAULTS.globalMaxConcurrent,
      maxAttempts: LLM_EXECUTION_DEFAULTS.retryMaxAttempts,
      baseBackoffMs: LLM_EXECUTION_DEFAULTS.retryBackoffMs,
      retryMaxDelayMs: LLM_EXECUTION_DEFAULTS.retryMaxDelayMs,
      requestTimeoutMs: LLM_EXECUTION_DEFAULTS.requestTimeoutMs,
      perAttemptTimeoutMs: LLM_EXECUTION_DEFAULTS.perAttemptTimeoutMs,
      globalConcurrencyEnabled: LLM_EXECUTION_DEFAULTS.globalConcurrencyEnabled,
    });
  });

  it('overrides defaults from env vars', () => {
    process.env.LLM_EXECUTION_ENABLED = 'false';
    process.env.LLM_MAX_CONCURRENT = '5';
    process.env.LLM_GLOBAL_MAX_CONCURRENT = '20';
    process.env.LLM_OPENAI_RETRY_MAX_ATTEMPTS = '1';
    process.env.LLM_OPENAI_RETRY_BACKOFF_MS = '500';
    process.env.LLM_OPENAI_RETRY_MAX_DELAY_MS = '4000';
    process.env.LLM_REQUEST_TIMEOUT_MS = '60000';
    process.env.LLM_GLOBAL_CONCURRENCY_ENABLED = 'true';

    const config = buildLlmExecutionConfig();
    expect(config.enabled).toBe(false);
    expect(config.maxConcurrent).toBe(5);
    expect(config.globalMaxConcurrent).toBe(20);
    expect(config.maxAttempts).toBe(1);
    expect(config.baseBackoffMs).toBe(500);
    expect(config.retryMaxDelayMs).toBe(4000);
    expect(config.requestTimeoutMs).toBe(60000);
    expect(config.globalConcurrencyEnabled).toBe(true);
  });

  it('falls back to defaults for invalid values', () => {
    process.env.LLM_MAX_CONCURRENT = 'not-a-number';
    process.env.LLM_OPENAI_RETRY_BACKOFF_MS = '-5';

    const config = buildLlmExecutionConfig();
    expect(config.maxConcurrent).toBe(LLM_EXECUTION_DEFAULTS.maxConcurrent);
    expect(config.baseBackoffMs).toBe(LLM_EXECUTION_DEFAULTS.retryBackoffMs);
  });

  it('accepts env overrides via explicit env parameter', () => {
    const config = buildLlmExecutionConfig({
      LLM_MAX_CONCURRENT: '8',
      LLM_GLOBAL_CONCURRENCY_ENABLED: 'true',
    });
    expect(config.maxConcurrent).toBe(8);
    expect(config.globalConcurrencyEnabled).toBe(true);
  });

  it('disables global concurrency when env var is missing', () => {
    const config = buildLlmExecutionConfig();
    expect(config.globalConcurrencyEnabled).toBe(false);
  });
});
