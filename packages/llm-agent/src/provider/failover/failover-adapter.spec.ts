import type {
  LlmJsonRequest,
  LlmJsonResponse,
  LlmToolChatRequest,
  LlmToolChatResponse,
  LlmProviderError,
} from '../types';
import type { LlmProviderAdapter } from '../llm-provider.adapter';
import {
  FailoverLlmProviderAdapter,
  type FailoverCircuitEvent,
} from './failover-adapter';
import { LlmAllProvidersExhaustedError } from './failover.errors';
import { LlmAttemptBudget } from '../../execution/attempt-budget';

type CandidateOverrides = {
  name: string;
  generateJson?: LlmProviderAdapter['generateJson'];
  chatWithTools?: LlmProviderAdapter['chatWithTools'];
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

function badRequestError(): LlmProviderError {
  return {
    provider: 'test',
    retryable: false,
    reason: 'bad_request',
    status: 400,
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
    it('stops failover and retry attempts at the shared generation budget', async () => {
      const calls = { total: 0 };
      const makeFailingCandidate = (name: string) =>
        makeCandidate({
          name,
          generateJson: jest
            .fn()
            .mockImplementation(async (request: LlmJsonRequest) => {
              request.attemptBudget?.consume();
              calls.total += 1;
              throw serverError();
            }),
          normalizeError: () => serverError(),
        });
      const adapter = new FailoverLlmProviderAdapter(
        [
          makeFailingCandidate('a'),
          makeFailingCandidate('b'),
          makeFailingCandidate('c'),
        ],
        undefined,
        Date.now,
        undefined,
        undefined,
        0,
        undefined,
        undefined,
        undefined,
        4,
      );

      await expect(
        adapter.generateJson({
          ...makeJsonRequest(),
          attemptBudget: new LlmAttemptBudget(6),
        }),
      ).rejects.toBeInstanceOf(LlmAllProvidersExhaustedError);
      expect(calls.total).toBe(6);
    });

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

    it('uses the configured retry budget for retryable provider failures', async () => {
      const generateJson = jest.fn().mockRejectedValue(new Error('server'));
      const candidate = makeCandidate({
        name: 'a',
        generateJson,
        normalizeError: () => serverError(),
      });
      const adapter = new FailoverLlmProviderAdapter(
        [candidate],
        undefined,
        Date.now,
        undefined,
        undefined,
        0,
        undefined,
        undefined,
        undefined,
        4,
      );

      await expect(adapter.generateJson(makeJsonRequest())).rejects.toThrow(
        LlmAllProvidersExhaustedError,
      );
      expect(generateJson).toHaveBeenCalledTimes(4);
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

  describe('QUICK_RETRY — server_error / unknown', () => {
    // #953: rate_limit moved to the long-cooldown family (AC: a rate-limit
    // error opens the long cooldown, preserving #870's 429 degraded
    // semantics) — it no longer quick-retries on the same provider.
    it('rate_limit: single attempt, then failover without quick retry', async () => {
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
      expect(callCountA).toBe(1);
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
        generateJson: async () => {
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
        generateJson: async () => {
          callCount++;
          if (callCount === 1) {
            throw Object.assign(new Error('server error'), { status: 500 });
          }
          return {
            content: 'ok',
            metadata: { provider: 'a', model: 'model-a' },
          };
        },
        normalizeError: () => serverError(),
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
    it('rejects request.model when multiple providers make the target ambiguous', async () => {
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
      await expect(
        adapter.generateJson({
          ...makeJsonRequest(),
          model: 'caller-model',
        }),
      ).rejects.toThrow(/multiple providers/i);
      expect(models).toEqual([]);
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

    it('preserves normalized reasons from every exhausted candidate', async () => {
      const candidateA = makeCandidate({
        name: 'a',
        generateJson: () => Promise.reject(new Error('invalid request')),
        normalizeError: () => badRequestError(),
      });
      const candidateB = makeCandidate({
        name: 'b',
        generateJson: () => Promise.reject(new Error('provider down')),
        normalizeError: () => serverError(),
      });
      const adapter = new FailoverLlmProviderAdapter(
        [candidateA, candidateB],
        undefined,
        Date.now,
        undefined,
        undefined,
        0,
        undefined,
        undefined,
        undefined,
        1,
      );

      await expect(
        adapter.generateJson(makeJsonRequest()),
      ).rejects.toMatchObject({
        failureReasons: ['bad_request', 'server_error'],
      });
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

  describe('#953 total-outage degraded mode', () => {
    const failingCandidate = (
      name: string,
      generateJson: jest.Mock,
    ): LlmProviderAdapter =>
      makeCandidate({
        name,
        generateJson,
        normalizeError: () => serverError(),
      });

    it('spends one attempt per provider per request while everything is cooling down', async () => {
      const clockValues = [0];
      const clock = () => clockValues[0];
      const callsA = jest.fn().mockRejectedValue(new Error('server'));
      const callsB = jest.fn().mockRejectedValue(new Error('server'));
      const adapter = new FailoverLlmProviderAdapter(
        [failingCandidate('a', callsA), failingCandidate('b', callsB)],
        undefined,
        clock,
        undefined,
        // Long short-cooldown keeps the total-outage window in the test.
        60_000,
        0,
        undefined,
        undefined,
        undefined,
        4,
      );

      // Request 1 — nothing is cooling: full budget per provider.
      await expect(adapter.generateJson(makeJsonRequest())).rejects.toThrow(
        LlmAllProvidersExhaustedError,
      );
      expect(callsA).toHaveBeenCalledTimes(4);
      expect(callsB).toHaveBeenCalledTimes(4);

      // Request 2 — both are cooling: degraded mode, one attempt each.
      clockValues[0] += 1_000;
      await expect(adapter.generateJson(makeJsonRequest())).rejects.toThrow(
        LlmAllProvidersExhaustedError,
      );
      expect(callsA).toHaveBeenCalledTimes(5);
      expect(callsB).toHaveBeenCalledTimes(5);

      // Request 3 — still cooling, still one attempt each.
      clockValues[0] += 1_000;
      await expect(adapter.generateJson(makeJsonRequest())).rejects.toThrow(
        LlmAllProvidersExhaustedError,
      );
      expect(callsA).toHaveBeenCalledTimes(6);
      expect(callsB).toHaveBeenCalledTimes(6);
    });

    it('emits no skip events during the degraded full-list fallback and calls every provider', async () => {
      const clockValues = [0];
      const clock = () => clockValues[0];
      const events: Array<{ provider: string; action: string }> = [];
      const attempts: string[] = [];
      const callsA = jest.fn().mockRejectedValue(new Error('server'));
      const callsB = jest.fn().mockRejectedValue(new Error('server'));
      const adapter = new FailoverLlmProviderAdapter(
        [failingCandidate('a', callsA), failingCandidate('b', callsB)],
        undefined,
        clock,
        undefined,
        60_000,
        0,
        (event) => events.push(event),
        (provider) => attempts.push(provider),
        undefined,
        2,
      );

      // Seed both circuits.
      await expect(adapter.generateJson(makeJsonRequest())).rejects.toThrow(
        LlmAllProvidersExhaustedError,
      );
      events.length = 0;
      attempts.length = 0;

      clockValues[0] += 1_000;
      await expect(adapter.generateJson(makeJsonRequest())).rejects.toThrow(
        LlmAllProvidersExhaustedError,
      );

      const skipCount = events.filter((e) => e.action === 'skip').length;
      const called = new Set(attempts);
      expect(called.has('a')).toBe(true);
      expect(called.has('b')).toBe(true);
      expect(skipCount).toBe(0);
    });

    it('emits skip events only for providers that are not subsequently called', async () => {
      const clockValues = [0];
      const clock = () => clockValues[0];
      const events: Array<{ provider: string; action: string }> = [];
      const attempts: string[] = [];
      const callsA = jest
        .fn()
        .mockRejectedValue(new Error('quota'))
        .mockName('a');
      const adapter = new FailoverLlmProviderAdapter(
        [
          makeCandidate({
            name: 'a',
            generateJson: callsA,
            normalizeError: () => quotaError(),
          }),
          makeCandidate({
            name: 'b',
            generateJson: () =>
              Promise.resolve({
                content: 'ok',
                metadata: { provider: 'b', model: 'model-b' },
              }),
          }),
        ],
        undefined,
        clock,
        undefined,
        undefined,
        0,
        (event) => events.push(event),
        (provider) => attempts.push(provider),
      );

      // Request 1: a fails (quota → long circuit), b succeeds.
      await adapter.generateJson(makeJsonRequest());
      expect(callsA).toHaveBeenCalledTimes(1);
      events.length = 0;
      attempts.length = 0;

      // Request 2: a is cooling and skipped; b is healthy and called.
      clockValues[0] += 1_000;
      await adapter.generateJson(makeJsonRequest());

      expect(events).toEqual([
        { provider: 'a', action: 'skip', reason: 'cooldown' },
      ]);
      expect(attempts).toEqual(['b']);
    });

    it('opens the long cooldown for a rate-limit error from a non-primary provider', async () => {
      const clockValues = [0];
      const clock = () => clockValues[0];
      const events: Array<{ provider: string; action: string }> = [];
      // a fails twice in request 1 (short budget), succeeds from request 2.
      const callsA = jest
        .fn()
        .mockRejectedValueOnce(new Error('server'))
        .mockRejectedValueOnce(new Error('server'))
        .mockResolvedValue({
          content: 'from-a',
          metadata: { provider: 'a', model: 'model-a' },
        });
      const callsB = jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('rate limit'), { status: 429 }),
        );
      const adapter = new FailoverLlmProviderAdapter(
        [
          makeCandidate({
            name: 'a',
            generateJson: callsA,
            normalizeError: () => serverError(),
          }),
          makeCandidate({
            name: 'b',
            generateJson: callsB,
            normalizeError: () => rateLimitError(),
          }),
        ],
        undefined,
        clock,
        undefined,
        undefined,
        0,
        (event) => events.push(event),
      );

      // Request 1: a fails (short 5s circuit), b fails rate-limit → long.
      await expect(adapter.generateJson(makeJsonRequest())).rejects.toThrow(
        LlmAllProvidersExhaustedError,
      );
      expect(callsA).toHaveBeenCalledTimes(2);
      expect(callsB).toHaveBeenCalledTimes(1);
      events.length = 0;

      // Request 2 at +6s: a succeeds immediately, b must still be cooling —
      // 6s > 5s short cooldown but 6s << 600s long cooldown.
      clockValues[0] += 6_000;
      const result = await adapter.generateJson(makeJsonRequest());
      expect(result.content).toBe('from-a');
      expect(callsA).toHaveBeenCalledTimes(3);
      expect(callsB).toHaveBeenCalledTimes(1);
      expect(events).toContainEqual({
        provider: 'b',
        action: 'skip',
        reason: 'cooldown',
      });
      // b was skipped, not called: no circuit open/close for b this round.
      expect(
        events.filter((e) => e.provider === 'b' && e.action !== 'skip'),
      ).toEqual([]);
    });

    it('keeps the full attempt budget for a provider that follows a quota-failing candidate', async () => {
      const callsB = jest.fn().mockRejectedValue(new Error('server'));
      const adapter = new FailoverLlmProviderAdapter(
        [
          makeCandidate({
            name: 'a',
            generateJson: jest
              .fn()
              .mockRejectedValue(Object.assign(new Error('quota'))),
            normalizeError: () => quotaError(),
          }),
          failingCandidate('b', callsB),
        ],
        undefined,
        Date.now,
        undefined,
        undefined,
        0,
        undefined,
        undefined,
        undefined,
        3,
      );

      await expect(adapter.generateJson(makeJsonRequest())).rejects.toThrow(
        LlmAllProvidersExhaustedError,
      );
      // The quota candidate gets one attempt; the next candidate still gets
      // the full configured budget (the old dead branch never reduced it).
      expect(callsB).toHaveBeenCalledTimes(3);
    });

    describe('per-provider error classification (#953 defect 3)', () => {
      it('passes through an already-classified provider error instead of re-classifying with the first candidate', async () => {
        const firstNormalize = jest.fn();
        const firstCandidate = makeCandidate({
          name: 'a',
          normalizeError: firstNormalize,
        });
        const adapter = new FailoverLlmProviderAdapter([firstCandidate]);

        const classified = {
          provider: 'b',
          retryable: true,
          reason: 'rate_limit' as const,
          status: 429,
        };
        expect(adapter.normalizeError(classified)).toBe(classified);
        expect(firstNormalize).not.toHaveBeenCalled();

        expect(adapter.isRateLimitError(classified)).toBe(true);
        expect(firstNormalize).not.toHaveBeenCalled();
      });

      it('falls back to the first candidate for unclassified errors', () => {
        const firstCandidate = makeCandidate({
          name: 'a',
          isRateLimitError: () => true,
          normalizeError: () => serverError(),
        });
        const adapter = new FailoverLlmProviderAdapter([firstCandidate]);
        const raw = new Error('opaque');
        expect(adapter.isRateLimitError(raw)).toBe(true);
        expect(adapter.normalizeError(raw)).toEqual(serverError());
      });
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

  describe('provider health telemetry and quarantine', () => {
    it('counts a completion without usage as a successful provider outcome', async () => {
      const outcomes: Array<[string, string]> = [];
      const adapter = new FailoverLlmProviderAdapter(
        [
          makeCandidate({
            name: 'a',
            generateJson: () =>
              Promise.resolve({
                content: 'ok',
                metadata: { provider: 'a', model: 'model-a' },
              }),
          }),
        ],
        undefined,
        Date.now,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        (provider, outcome) => outcomes.push([provider, outcome]),
      );

      await adapter.generateJson(makeJsonRequest());

      expect(outcomes).toEqual([['a', 'success']]);
    });

    it('quarantines after three auth failures and never calls the provider again', async () => {
      const generateJson = jest.fn().mockRejectedValue(new Error('auth'));
      const events: FailoverCircuitEvent[] = [];
      const adapter = new FailoverLlmProviderAdapter(
        [
          makeCandidate({
            name: 'a',
            generateJson,
            normalizeError: () => authError(),
          }),
        ],
        undefined,
        Date.now,
        undefined,
        undefined,
        undefined,
        (event) => events.push(event),
        undefined,
        undefined,
        1,
      );

      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(adapter.generateJson(makeJsonRequest())).rejects.toThrow(
          LlmAllProvidersExhaustedError,
        );
      }
      await expect(adapter.generateJson(makeJsonRequest())).rejects.toThrow(
        LlmAllProvidersExhaustedError,
      );

      expect(generateJson).toHaveBeenCalledTimes(3);
      expect(events).toContainEqual({
        provider: 'a',
        action: 'quarantine',
        reason: 'auth',
      });
      expect(events).toContainEqual({
        provider: 'a',
        action: 'skip',
        reason: 'auth_quarantine',
      });
    });

    it('does not degraded-probe when every provider is quarantined', async () => {
      const callsA = jest.fn().mockRejectedValue(new Error('auth'));
      const callsB = jest.fn().mockRejectedValue(new Error('auth'));
      const events: FailoverCircuitEvent[] = [];
      const adapter = new FailoverLlmProviderAdapter(
        [
          makeCandidate({
            name: 'a',
            generateJson: callsA,
            normalizeError: () => authError(),
          }),
          makeCandidate({
            name: 'b',
            generateJson: callsB,
            normalizeError: () => authError(),
          }),
        ],
        undefined,
        Date.now,
        undefined,
        undefined,
        undefined,
        (event) => events.push(event),
        undefined,
        undefined,
        1,
      );

      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(adapter.generateJson(makeJsonRequest())).rejects.toThrow(
          LlmAllProvidersExhaustedError,
        );
      }
      const callsBeforeQuarantineProbe = [
        callsA.mock.calls.length,
        callsB.mock.calls.length,
      ];

      await expect(adapter.generateJson(makeJsonRequest())).rejects.toThrow(
        LlmAllProvidersExhaustedError,
      );

      expect([callsA.mock.calls.length, callsB.mock.calls.length]).toEqual(
        callsBeforeQuarantineProbe,
      );
      expect(events.filter((event) => event.action === 'skip')).toEqual(
        expect.arrayContaining([
          { provider: 'a', action: 'skip', reason: 'auth_quarantine' },
          { provider: 'b', action: 'skip', reason: 'auth_quarantine' },
        ]),
      );
    });

    it('emits never-served once per long-cooldown streak and resets after success', async () => {
      const outcomes: string[] = [];
      const neverSucceeded: string[] = [];
      let calls = 0;
      const adapter = new FailoverLlmProviderAdapter(
        [
          makeCandidate({
            name: 'a',
            generateJson: () => {
              calls += 1;
              if (calls === 4) {
                return Promise.resolve({
                  content: 'recovered',
                  metadata: { provider: 'a', model: 'model-a' },
                });
              }
              throw new Error('quota');
            },
            normalizeError: () => quotaError(),
          }),
        ],
        undefined,
        Date.now,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        1,
        (provider, outcome) => outcomes.push(`${provider}:${outcome}`),
        (provider) => neverSucceeded.push(provider),
      );

      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(adapter.generateJson(makeJsonRequest())).rejects.toThrow(
          LlmAllProvidersExhaustedError,
        );
      }
      expect(neverSucceeded).toEqual(['a']);

      await expect(adapter.generateJson(makeJsonRequest())).resolves.toEqual(
        expect.objectContaining({ content: 'recovered' }),
      );

      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(adapter.generateJson(makeJsonRequest())).rejects.toThrow(
          LlmAllProvidersExhaustedError,
        );
      }
      expect(neverSucceeded).toEqual(['a', 'a']);
      expect(
        outcomes.filter((outcome) => outcome.endsWith(':success')),
      ).toHaveLength(1);
    });
  });
});
