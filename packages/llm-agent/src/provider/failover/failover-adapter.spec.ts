import type {
  LlmJsonRequest,
  LlmJsonResponse,
  LlmToolChatRequest,
  LlmToolChatResponse,
  LlmStreamEvent,
  LlmProviderError,
} from '../types';
import type { LlmProviderAdapter } from '../llm-provider.adapter';
import { FailoverLlmProviderAdapter } from './failover-adapter';
import { LlmAllProvidersExhaustedError } from './failover.errors';

type CandidateOverrides = {
  name: string;
  generateJson?: LlmProviderAdapter['generateJson'];
  chatWithTools?: LlmProviderAdapter['chatWithTools'];
  chatStream?: LlmProviderAdapter['chatStream'];
  isRetryableError?: LlmProviderAdapter['isRetryableError'];
  isRateLimitError?: LlmProviderAdapter['isRateLimitError'];
  normalizeError?: LlmProviderAdapter['normalizeError'];
};

function makeCandidate(overrides: CandidateOverrides): LlmProviderAdapter {
  const noop = () => {
    throw new Error('not implemented in test');
  };
  return {
    providerName: overrides.name,
    isConfigured: () => true,
    getDefaultModel: () => `model-${overrides.name}`,
    generateJson: overrides.generateJson ?? noop,
    chatWithTools: overrides.chatWithTools ?? noop,
    chatStream:
      overrides.chatStream ??
      (() => {
        function* gen(): AsyncIterable<LlmStreamEvent> {
          yield { type: 'done', response: {} as LlmToolChatResponse };
        }
        return gen();
      }),
    isRetryableError: overrides.isRetryableError ?? (() => false),
    isRateLimitError: overrides.isRateLimitError ?? (() => false),
    normalizeError:
      overrides.normalizeError ??
      (() => ({
        provider: overrides.name,
        retryable: false,
        reason: 'unknown' as const,
      })),
  };
}

function makeJsonRequest(): LlmJsonRequest {
  return {
    feature: 'FREE_FORM_CHAT',
    systemPrompt: 'test',
    userContent: 'hello',
  };
}

function makeToolChatRequest(): LlmToolChatRequest {
  return {
    feature: 'FREE_FORM_CHAT',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
  };
}

function quotaError(): LlmProviderError {
  return {
    provider: 'test',
    retryable: false,
    reason: 'quota_exceeded',
    status: 402,
  };
}

function rateLimitError(): LlmProviderError {
  return {
    provider: 'test',
    retryable: true,
    reason: 'rate_limit',
    status: 429,
  };
}

function serverError(): LlmProviderError {
  return {
    provider: 'test',
    retryable: true,
    reason: 'server_error',
    status: 500,
  };
}

function authError(): LlmProviderError {
  return { provider: 'test', retryable: false, reason: 'auth', status: 401 };
}

describe('FailoverLlmProviderAdapter', () => {
  describe('isConfigured', () => {
    it('returns true when candidates exist', () => {
      const adapter = new FailoverLlmProviderAdapter([
        makeCandidate({ name: 'a' }),
      ]);
      expect(adapter.isConfigured()).toBe(true);
    });

    it('returns false when no candidates', () => {
      const adapter = new FailoverLlmProviderAdapter([]);
      expect(adapter.isConfigured()).toBe(false);
    });
  });

  describe('isRetryableError', () => {
    it('always returns false', () => {
      const adapter = new FailoverLlmProviderAdapter([
        makeCandidate({ name: 'a' }),
      ]);
      expect(adapter.isRetryableError(new Error())).toBe(false);
    });
  });

  describe('getDefaultModel', () => {
    it('returns first candidate default model', () => {
      const adapter = new FailoverLlmProviderAdapter([
        makeCandidate({ name: 'a' }),
        makeCandidate({ name: 'b' }),
      ]);
      expect(adapter.getDefaultModel()).toBe('model-a');
    });
  });

  describe('generateJson — failover', () => {
    it('candidate 1 fails → candidate 2 succeeds → returns candidate 2 result', async () => {
      const result: LlmJsonResponse = {
        content: '{"ok":true}',
        metadata: { provider: 'b', model: 'model-b' },
      };
      const candidateA = makeCandidate({
        name: 'a',
        generateJson: () => {
          throw Object.assign(new Error('quota'), { status: 402 });
        },
        normalizeError: () => quotaError(),
      });
      const candidateB = makeCandidate({
        name: 'b',
        generateJson: () => Promise.resolve(result),
      });

      const adapter = new FailoverLlmProviderAdapter([candidateA, candidateB]);
      const out = await adapter.generateJson(makeJsonRequest());
      expect(out).toBe(result);
    });

    it('all candidates fail → throws LlmAllProvidersExhaustedError', async () => {
      const candidateA = makeCandidate({
        name: 'a',
        generateJson: () => {
          throw Object.assign(new Error('quota'), { status: 402 });
        },
        normalizeError: () => quotaError(),
      });
      const candidateB = makeCandidate({
        name: 'b',
        generateJson: () => {
          throw Object.assign(new Error('server'), { status: 500 });
        },
        normalizeError: () => serverError(),
      });

      const adapter = new FailoverLlmProviderAdapter([candidateA, candidateB]);
      await expect(adapter.generateJson(makeJsonRequest())).rejects.toThrow(
        LlmAllProvidersExhaustedError,
      );
    });

    it('emits bounded provider attempt, circuit, and exhaustion telemetry', async () => {
      const attempts: Array<[string, string | undefined]> = [];
      const circuitEvents: string[] = [];
      const exhausted: string[][] = [];
      const candidateA = makeCandidate({
        name: 'a',
        generateJson: () => {
          throw Object.assign(new Error('quota'), { status: 402 });
        },
        normalizeError: () => quotaError(),
      });
      const candidateB = makeCandidate({
        name: 'b',
        generateJson: () => {
          throw Object.assign(new Error('server'), { status: 500 });
        },
        normalizeError: () => serverError(),
      });

      const adapter = new FailoverLlmProviderAdapter(
        [candidateA, candidateB],
        undefined,
        Date.now,
        undefined,
        undefined,
        0,
        (event) => circuitEvents.push(`${event.provider}:${event.action}`),
        (provider, feature) => attempts.push([provider, feature]),
        (providers) => exhausted.push(providers),
      );

      await expect(adapter.generateJson(makeJsonRequest())).rejects.toThrow(
        LlmAllProvidersExhaustedError,
      );
      expect(attempts).toEqual([
        ['a', 'FREE_FORM_CHAT'],
        ['b', 'FREE_FORM_CHAT'],
        ['b', 'FREE_FORM_CHAT'],
      ]);
      expect(circuitEvents).toEqual(['a:open', 'b:open']);
      expect(exhausted).toEqual([['a', 'b']]);
    });
  });

  describe('chatWithTools — failover', () => {
    it('candidate 1 fails → candidate 2 succeeds', async () => {
      const result: LlmToolChatResponse = {
        message: { role: 'assistant', content: 'hi' },
        content: 'hi',
        metadata: { provider: 'b', model: 'model-b' },
      };
      const candidateA = makeCandidate({
        name: 'a',
        chatWithTools: () => {
          throw Object.assign(new Error('rate limit'), { status: 429 });
        },
        normalizeError: () => rateLimitError(),
      });
      const candidateB = makeCandidate({
        name: 'b',
        chatWithTools: () => Promise.resolve(result),
      });

      const adapter = new FailoverLlmProviderAdapter([candidateA, candidateB]);
      const out = await adapter.chatWithTools(makeToolChatRequest());
      expect(out).toBe(result);
    });
  });

  describe('FAST_FAIL — quota_exceeded / auth', () => {
    it('quota_exceeded: calls candidate exactly once, then failover', async () => {
      let callCount = 0;
      const candidateA = makeCandidate({
        name: 'a',
        generateJson: () => {
          callCount++;
          throw Object.assign(new Error('quota'), { status: 402 });
        },
        normalizeError: () => quotaError(),
      });
      const candidateB = makeCandidate({
        name: 'b',
        generateJson: () =>
          Promise.resolve({
            content: 'ok',
            metadata: { provider: 'b', model: 'model-b' },
          }),
      });

      const adapter = new FailoverLlmProviderAdapter([candidateA, candidateB]);
      await adapter.generateJson(makeJsonRequest());
      expect(callCount).toBe(1);
    });

    it('auth: calls candidate exactly once, then failover', async () => {
      let callCount = 0;
      const candidateA = makeCandidate({
        name: 'a',
        generateJson: () => {
          callCount++;
          throw Object.assign(new Error('auth'), { status: 401 });
        },
        normalizeError: () => authError(),
      });
      const candidateB = makeCandidate({
        name: 'b',
        generateJson: () =>
          Promise.resolve({
            content: 'ok',
            metadata: { provider: 'b', model: 'model-b' },
          }),
      });

      const adapter = new FailoverLlmProviderAdapter([candidateA, candidateB]);
      await adapter.generateJson(makeJsonRequest());
      expect(callCount).toBe(1);
    });

    it('sets long cooldown for fast-fail errors', async () => {
      const clockValues = [0];
      const clock = () => clockValues[0];

      const candidateA = makeCandidate({
        name: 'a',
        generateJson: () => {
          throw Object.assign(new Error('quota'), { status: 402 });
        },
        normalizeError: () => quotaError(),
      });
      const candidateB = makeCandidate({
        name: 'b',
        generateJson: () =>
          Promise.resolve({
            content: 'ok',
            metadata: { provider: 'b', model: 'model-b' },
          }),
      });

      clockValues[0] = 1000;
      const adapter = new FailoverLlmProviderAdapter(
        [candidateA, candidateB],
        undefined,
        clock,
      );
      await adapter.generateJson(makeJsonRequest());

      // Next call: candidate A should be skipped (healthyAgainAt = 1000 + 600000)
      let callCountB = 0;
      const candidateB2 = makeCandidate({
        name: 'b',
        generateJson: () => {
          callCountB++;
          throw Object.assign(new Error('quota'), { status: 402 });
        },
        normalizeError: () => quotaError(),
      });

      clockValues[0] = 1001;
      const adapter2 = new FailoverLlmProviderAdapter(
        [candidateA, candidateB2],
        undefined,
        clock,
      );

      await expect(adapter2.generateJson(makeJsonRequest())).rejects.toThrow(
        LlmAllProvidersExhaustedError,
      );
      expect(callCountB).toBe(1);
    });
  });

  describe('QUICK_RETRY — rate_limit / server_error / unknown', () => {
    it('rate_limit: retries once on same provider before failover', async () => {
      let callCount = 0;
      const candidateA = makeCandidate({
        name: 'a',
        generateJson: () => {
          callCount++;
          if (callCount === 1) {
            throw Object.assign(new Error('rate limit'), { status: 429 });
          }
          return {
            content: 'ok',
            metadata: { provider: 'a', model: 'model-a' },
          };
        },
        normalizeError: () => rateLimitError(),
      });

      const adapter = new FailoverLlmProviderAdapter([candidateA]);
      const result = await adapter.generateJson(makeJsonRequest());
      expect(callCount).toBe(2);
      expect(result.content).toBe('ok');
    });

    it('rate_limit: both retries fail → failover to next', async () => {
      let callCountA = 0;
      const candidateA = makeCandidate({
        name: 'a',
        generateJson: () => {
          callCountA++;
          throw Object.assign(new Error('rate limit'), { status: 429 });
        },
        normalizeError: () => rateLimitError(),
      });
      const candidateB = makeCandidate({
        name: 'b',
        generateJson: () =>
          Promise.resolve({
            content: 'from-b',
            metadata: { provider: 'b', model: 'model-b' },
          }),
      });

      const adapter = new FailoverLlmProviderAdapter([candidateA, candidateB]);
      const result = await adapter.generateJson(makeJsonRequest());
      expect(callCountA).toBe(2);
      expect(result.content).toBe('from-b');
    });

    it('sets short cooldown for transient errors', async () => {
      const clockValues = [0];
      const clock = () => clockValues[0];

      const candidateA = makeCandidate({
        name: 'a',
        generateJson: () => {
          throw Object.assign(new Error('server error'), { status: 500 });
        },
        normalizeError: () => serverError(),
      });
      const candidateB = makeCandidate({
        name: 'b',
        generateJson: () =>
          Promise.resolve({
            content: 'ok',
            metadata: { provider: 'b', model: 'model-b' },
          }),
      });

      const adapter = new FailoverLlmProviderAdapter(
        [candidateA, candidateB],
        undefined,
        clock,
      );

      clockValues[0] = 1000;
      await adapter.generateJson(makeJsonRequest());

      clockValues[0] = 6001;

      let callCountA = 0;
      const candidateA2 = makeCandidate({
        name: 'a',
        generateJson: () => {
          callCountA++;
          return {
            content: 'retry-ok',
            metadata: { provider: 'a', model: 'model-a' },
          };
        },
      });
      const candidateB2 = makeCandidate({
        name: 'b',
        generateJson: () => {
          throw Object.assign(new Error('quota'), { status: 402 });
        },
        normalizeError: () => quotaError(),
      });

      const adapter2 = new FailoverLlmProviderAdapter(
        [candidateA2, candidateB2],
        undefined,
        clock,
      );
      const result = await adapter2.generateJson(makeJsonRequest());
      expect(callCountA).toBe(1);
      expect(result.content).toBe('retry-ok');
    });
  });

  describe('circuit breaker', () => {
    it('skips candidate in cooldown', async () => {
      const clockValues = [0];
      const clock = () => clockValues[0];

      const candidateA = makeCandidate({
        name: 'a',
        generateJson: () => {
          throw Object.assign(new Error('quota'), { status: 402 });
        },
        normalizeError: () => quotaError(),
      });
      const candidateB = makeCandidate({
        name: 'b',
        generateJson: () =>
          Promise.resolve({
            content: 'ok',
            metadata: { provider: 'b', model: 'model-b' },
          }),
      });

      clockValues[0] = 1000;
      const adapter = new FailoverLlmProviderAdapter(
        [candidateA, candidateB],
        undefined,
        clock,
      );
      await adapter.generateJson(makeJsonRequest());

      clockValues[0] = 2000;
      const candidateA2 = makeCandidate({
        name: 'a',
        generateJson: () => {
          throw Object.assign(new Error('quota'), { status: 402 });
        },
        normalizeError: () => quotaError(),
      });
      const candidateB2 = makeCandidate({
        name: 'b',
        generateJson: () =>
          Promise.resolve({
            content: 'from-b',
            metadata: { provider: 'b', model: 'model-b' },
          }),
      });

      const adapter2 = new FailoverLlmProviderAdapter(
        [candidateA2, candidateB2],
        undefined,
        clock,
      );
      const result = await adapter2.generateJson(makeJsonRequest());
      expect(result.content).toBe('from-b');
    });

    it('resets circuit on success', async () => {
      const clockValues = [0];
      const clock = () => clockValues[0];

      let callCount = 0;
      const candidateA = makeCandidate({
        name: 'a',
        generateJson: () => {
          callCount++;
          if (callCount === 1) {
            throw Object.assign(new Error('rate limit'), { status: 429 });
          }
          return {
            content: 'ok',
            metadata: { provider: 'a', model: 'model-a' },
          };
        },
        normalizeError: () => rateLimitError(),
      });

      const adapter = new FailoverLlmProviderAdapter(
        [candidateA],
        undefined,
        clock,
      );

      clockValues[0] = 1000;
      const result = await adapter.generateJson(makeJsonRequest());
      expect(result.content).toBe('ok');

      clockValues[0] = 2000;
      const result2 = await adapter.generateJson(makeJsonRequest());
      expect(result2.content).toBe('ok');
    });

    it('all candidates in cooldown → falls back to full list', async () => {
      const clockValues = [0];
      const clock = () => clockValues[0];

      const candidateA = makeCandidate({
        name: 'a',
        generateJson: () => {
          throw Object.assign(new Error('quota'), { status: 402 });
        },
        normalizeError: () => quotaError(),
      });
      const candidateB = makeCandidate({
        name: 'b',
        generateJson: () => {
          throw Object.assign(new Error('quota'), { status: 402 });
        },
        normalizeError: () => quotaError(),
      });

      clockValues[0] = 1000;
      const adapter = new FailoverLlmProviderAdapter(
        [candidateA, candidateB],
        undefined,
        clock,
      );

      await expect(adapter.generateJson(makeJsonRequest())).rejects.toThrow(
        LlmAllProvidersExhaustedError,
      );

      clockValues[0] = 2000;
      let callCountA = 0;
      const candidateA2 = makeCandidate({
        name: 'a',
        generateJson: () => {
          callCountA++;
          throw Object.assign(new Error('quota'), { status: 402 });
        },
        normalizeError: () => quotaError(),
      });
      const candidateB2 = makeCandidate({
        name: 'b',
        generateJson: () => {
          throw Object.assign(new Error('quota'), { status: 402 });
        },
        normalizeError: () => quotaError(),
      });

      const adapter2 = new FailoverLlmProviderAdapter(
        [candidateA2, candidateB2],
        undefined,
        clock,
      );
      await expect(adapter2.generateJson(makeJsonRequest())).rejects.toThrow(
        LlmAllProvidersExhaustedError,
      );
      expect(callCountA).toBe(1);
    });
  });

  describe('model override', () => {
    it('overrides request.model with candidate defaultModel', async () => {
      const models: string[] = [];
      const candidateA = makeCandidate({
        name: 'a',
        generateJson: (req) => {
          models.push(req.model ?? 'undefined');
          throw Object.assign(new Error('fail'), { status: 500 });
        },
        normalizeError: () => serverError(),
      });
      const candidateB = makeCandidate({
        name: 'b',
        generateJson: (req) => {
          models.push(req.model ?? 'undefined');
          return Promise.resolve({
            content: 'ok',
            metadata: { provider: 'b', model: req.model ?? 'undefined' },
          });
        },
      });

      const adapter = new FailoverLlmProviderAdapter([candidateA, candidateB]);
      await adapter.generateJson({
        ...makeJsonRequest(),
        model: 'caller-model',
      });
      // candidate A: server_error → QUICK_RETRY → 2 attempts, then candidate B: 1 attempt
      expect(models).toEqual(['model-a', 'model-a', 'model-b']);
    });
  });

  describe('chatStream', () => {
    it('does not failover mid-stream, but respects circuit breaker', async () => {
      const candidateA = makeCandidate({
        name: 'a',
        chatStream: () => {
          function* gen(): AsyncIterable<LlmStreamEvent> {
            yield { type: 'delta', textDelta: 'hello' };
            yield { type: 'done', response: {} as LlmToolChatResponse };
          }
          return gen();
        },
      });
      const candidateB = makeCandidate({
        name: 'b',
        chatStream: () => {
          function* gen(): AsyncIterable<LlmStreamEvent> {
            yield { type: 'delta', textDelta: 'from-b' };
            yield { type: 'done', response: {} as LlmToolChatResponse };
          }
          return gen();
        },
      });

      const adapter = new FailoverLlmProviderAdapter([candidateA, candidateB]);
      const stream = adapter.chatStream(makeToolChatRequest());
      const events: LlmStreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }
      expect(events[0]).toEqual({ type: 'delta', textDelta: 'hello' });
    });
  });

  describe('LlmAllProvidersExhaustedError', () => {
    it('contains correct provider list and last error', async () => {
      const lastErr = new Error('last');
      const candidateA = makeCandidate({
        name: 'a',
        generateJson: () => {
          throw Object.assign(new Error('fail'), { status: 500 });
        },
        normalizeError: () => serverError(),
      });
      const candidateB = makeCandidate({
        name: 'b',
        generateJson: () => {
          throw lastErr;
        },
        normalizeError: () => serverError(),
      });

      const adapter = new FailoverLlmProviderAdapter([candidateA, candidateB]);
      try {
        await adapter.generateJson(makeJsonRequest());
        fail('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(LlmAllProvidersExhaustedError);
        expect((e as LlmAllProvidersExhaustedError).providers).toEqual([
          'a',
          'b',
        ]);
        expect((e as LlmAllProvidersExhaustedError).lastError).toBe(lastErr);
      }
    });
  });

  describe('logging', () => {
    it('warns on each failover', async () => {
      const warns: string[] = [];
      const candidateA = makeCandidate({
        name: 'a',
        generateJson: () => {
          throw Object.assign(new Error('quota'), { status: 402 });
        },
        normalizeError: () => quotaError(),
      });
      const candidateB = makeCandidate({
        name: 'b',
        generateJson: () =>
          Promise.resolve({
            content: 'ok',
            metadata: { provider: 'b', model: 'model-b' },
          }),
      });

      const adapter = new FailoverLlmProviderAdapter([candidateA, candidateB], {
        warn: (msg) => warns.push(msg),
      });
      await adapter.generateJson(makeJsonRequest());
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain(
        'LLM_FAILOVER provider=a reason=quota_exceeded',
      );
    });
  });

  describe('AbortSignal propagation', () => {
    it('does not try candidate B when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const generateJsonA = jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('Aborted'), { name: 'AbortError' }),
        );
      const generateJsonB = jest.fn().mockResolvedValue({
        content: '{}',
        metadata: { provider: 'b', model: 'model-b' },
      });
      const candidateA = makeCandidate({
        name: 'a',
        generateJson: generateJsonA,
      });
      const candidateB = makeCandidate({
        name: 'b',
        generateJson: generateJsonB,
      });

      const adapter = new FailoverLlmProviderAdapter([candidateA, candidateB]);

      await expect(
        adapter.generateJson({
          ...makeJsonRequest(),
          signal: controller.signal,
        }),
      ).rejects.toThrow();

      expect(generateJsonB).not.toHaveBeenCalled();
    });

    it('does not try candidate B when candidate A throws AbortError mid-request', async () => {
      const abortErr = Object.assign(new Error('aborted'), {
        name: 'AbortError',
      });
      const generateJsonA = jest.fn().mockRejectedValue(abortErr);
      const generateJsonB = jest.fn().mockResolvedValue({
        content: '{}',
        metadata: { provider: 'b', model: 'model-b' },
      });
      const candidateA = makeCandidate({
        name: 'a',
        generateJson: generateJsonA,
      });
      const candidateB = makeCandidate({
        name: 'b',
        generateJson: generateJsonB,
      });

      const adapter = new FailoverLlmProviderAdapter([candidateA, candidateB]);

      await expect(adapter.generateJson(makeJsonRequest())).rejects.toThrow(
        abortErr,
      );

      expect(generateJsonB).not.toHaveBeenCalled();
    });
  });
});
