import { OpenAiAdapter } from './openai-adapter';

function makeAdapter(overrides?: { providerName?: string }): OpenAiAdapter {
  return new OpenAiAdapter(
    () => 'test-key',
    () => 'gpt-test',
    undefined,
    overrides?.providerName,
  );
}

function makeError(
  status: number,
  message = '',
  name = 'Error',
  code?: string,
): Error & { status: number; message: string; code?: string } {
  const err = new Error(message) as Error & {
    status: number;
    message: string;
    code?: string;
  };
  err.name = name;
  err.status = status;
  if (code) err.code = code;
  return err;
}

describe('OpenAiAdapter', () => {
  describe('normalizeError — quota_exceeded', () => {
    it('returns quota_exceeded for HTTP 402', () => {
      const adapter = makeAdapter();
      const err = makeError(402, 'Payment Required');
      const result = adapter.normalizeError(err);
      expect(result).toEqual({
        provider: 'openai',
        retryable: false,
        reason: 'quota_exceeded',
        status: 402,
      });
    });

    it('returns quota_exceeded for 429 + insufficient_quota in message', () => {
      const adapter = makeAdapter();
      const err = makeError(429, 'insufficient_quota');
      const result = adapter.normalizeError(err);
      expect(result.reason).toBe('quota_exceeded');
      expect(result.retryable).toBe(false);
    });

    it('returns quota_exceeded for 429 + insufficient credit in message', () => {
      const adapter = makeAdapter();
      const err = makeError(429, 'insufficient credit balance');
      const result = adapter.normalizeError(err);
      expect(result.reason).toBe('quota_exceeded');
    });

    it('returns quota_exceeded for 400 + billing in code', () => {
      const adapter = makeAdapter();
      const err = makeError(400, 'Bad request', 'Error', 'billing_issue');
      const result = adapter.normalizeError(err);
      expect(result.reason).toBe('quota_exceeded');
    });

    it('returns quota_exceeded for 429 + insufficient balance in message', () => {
      const adapter = makeAdapter();
      const err = makeError(429, 'insufficient balance');
      const result = adapter.normalizeError(err);
      expect(result.reason).toBe('quota_exceeded');
    });

    it('uses custom providerName', () => {
      const adapter = makeAdapter({ providerName: 'openrouter' });
      const err = makeError(402, 'Payment Required');
      const result = adapter.normalizeError(err);
      expect(result.provider).toBe('openrouter');
      expect(result.reason).toBe('quota_exceeded');
    });
  });

  describe('normalizeError — rate_limit (unchanged)', () => {
    it('returns rate_limit for RateLimitError name', () => {
      const adapter = makeAdapter();
      const err = makeError(429, 'Rate limit exceeded', 'RateLimitError');
      const result = adapter.normalizeError(err);
      expect(result).toEqual({
        provider: 'openai',
        retryable: true,
        reason: 'rate_limit',
        status: 429,
      });
    });

    it('returns rate_limit for 429 without quota markers', () => {
      const adapter = makeAdapter();
      const err = makeError(429, 'openai rate limit');
      const result = adapter.normalizeError(err);
      expect(result.reason).toBe('rate_limit');
    });
  });

  describe('normalizeError — server_error', () => {
    it('returns server_error for 500', () => {
      const adapter = makeAdapter();
      const err = makeError(500, 'Internal Server Error');
      const result = adapter.normalizeError(err);
      expect(result).toEqual({
        provider: 'openai',
        retryable: true,
        reason: 'server_error',
        status: 500,
      });
    });

    it('returns server_error for InternalServerError name', () => {
      const adapter = makeAdapter();
      const err = makeError(500, 'Something broke', 'InternalServerError');
      const result = adapter.normalizeError(err);
      expect(result.reason).toBe('server_error');
    });
  });

  describe('normalizeError — auth', () => {
    it('returns auth for 401', () => {
      const adapter = makeAdapter();
      const err = makeError(401, 'Unauthorized');
      const result = adapter.normalizeError(err);
      expect(result).toEqual({
        provider: 'openai',
        retryable: false,
        reason: 'auth',
        status: 401,
      });
    });

    it('returns auth for 403', () => {
      const adapter = makeAdapter();
      const err = makeError(403, 'Forbidden');
      const result = adapter.normalizeError(err);
      expect(result.reason).toBe('auth');
    });
  });

  describe('normalizeError — unknown', () => {
    it('returns unknown for unrecognized error', () => {
      const adapter = makeAdapter();
      const err = new Error('something weird');
      const result = adapter.normalizeError(err);
      expect(result).toEqual({
        provider: 'openai',
        retryable: false,
        reason: 'unknown',
        status: undefined,
      });
    });
  });

  describe('isRetryableError', () => {
    it('returns true for rate_limit', () => {
      const adapter = makeAdapter();
      const err = makeError(429, 'Rate limit', 'RateLimitError');
      expect(adapter.isRetryableError(err)).toBe(true);
    });

    it('returns true for server_error', () => {
      const adapter = makeAdapter();
      const err = makeError(500, 'Internal Server Error');
      expect(adapter.isRetryableError(err)).toBe(true);
    });

    it('returns false for quota_exceeded', () => {
      const adapter = makeAdapter();
      const err = makeError(402, 'Payment Required');
      expect(adapter.isRetryableError(err)).toBe(false);
    });

    it('returns false for AbortError', () => {
      const adapter = makeAdapter();
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      expect(adapter.isRetryableError(err)).toBe(false);
    });
  });

  describe('generateJson', () => {
    it('passes signal to OpenAI completions client when provided', async () => {
      const adapter = makeAdapter();
      const createMock = jest.fn().mockResolvedValue({
        id: 'resp-1',
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      (
        adapter as unknown as {
          client: { chat: { completions: { create: typeof createMock } } };
        }
      ).client = {
        chat: {
          completions: {
            create: createMock,
          },
        },
      };

      const controller = new AbortController();
      const res = await adapter.generateJson({
        feature: 'STUDENT_REPORT',
        systemPrompt: 'prompt',
        userContent: 'content',
        signal: controller.signal,
      });

      expect(res.content).toBe('{"ok":true}');
      expect(createMock).toHaveBeenCalledWith(expect.any(Object), {
        signal: controller.signal,
      });
    });
  });

  describe('isConfigured / getDefaultModel / providerName', () => {
    it('isConfigured returns true when API key is present', () => {
      const adapter = makeAdapter();
      expect(adapter.isConfigured()).toBe(true);
    });

    it('isConfigured returns false when API key is missing', () => {
      const adapter = new OpenAiAdapter(
        () => undefined,
        () => 'gpt-test',
      );
      expect(adapter.isConfigured()).toBe(false);
    });

    it('providerName defaults to openai', () => {
      const adapter = makeAdapter();
      expect(adapter.providerName).toBe('openai');
    });

    it('getDefaultModel returns configured model', () => {
      const adapter = makeAdapter();
      expect(adapter.getDefaultModel()).toBe('gpt-test');
    });
  });
});
