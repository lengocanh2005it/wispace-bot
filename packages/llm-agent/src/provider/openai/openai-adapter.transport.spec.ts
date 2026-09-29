/**
 * #1473 — the provider-attempt budget's unit of account must equal the unit
 * that is actually billed.
 *
 * Every other adapter spec substitutes the private `client` field, so nothing
 * in the suite ever reaches client construction and the SDK's own transport
 * retries are invisible. This spec builds the adapter through the production
 * factory and counts real transport requests instead.
 */
import {
  createFailoverLlmProviderAdapter,
  createLlmProviderAdapter,
} from '../factory';
import { LlmAttemptBudget } from '../../execution/attempt-budget';
import { LLM_EXECUTION_DEFAULTS } from '../../execution/llm-execution.config';
import type { LlmProviderPolicy } from '../provider-policy';
import type { LlmProviderAdapter } from '../llm-provider.adapter';
import type { LlmToolChatRequest } from '../types';

const TEST_POLICY: LlmProviderPolicy = {
  nodeEnv: 'test',
  allowedBaseUrlHosts: ['provider.test'],
  allowedModels: ['openai:gpt-5.4'],
};

const RATE_LIMIT_BODY = JSON.stringify({
  error: { message: 'rate limit reached', type: 'requests' },
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function toolCallResponse(): Response {
  return jsonResponse({
    id: 'chatcmpl-transport',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'gpt-5.4',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'Xin chào' },
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  });
}

function rateLimitResponse(): Response {
  return new Response(RATE_LIMIT_BODY, {
    status: 429,
    headers: { 'content-type': 'application/json' },
  });
}

function toolChatRequest(
  attemptBudget: LlmAttemptBudget,
  signal?: AbortSignal,
): LlmToolChatRequest {
  return {
    feature: 'FREE_FORM_CHAT',
    messages: [{ role: 'user', content: 'Chào bạn' }],
    tools: [],
    toolChoice: 'auto',
    signal,
    attemptBudget,
  };
}

describe('one provider attempt is one provider request (#1473)', () => {
  let requestsIssued = 0;
  let respond: () => Response;
  let transport: typeof globalThis.fetch;

  beforeEach(() => {
    requestsIssued = 0;
    respond = toolCallResponse;
    // The SDK resolves the transport at client construction time, so this must
    // be handed to the adapter before the first provider call — swapping the
    // global afterwards would never be observed.
    transport = (async () => {
      requestsIssued += 1;
      return respond();
    }) as unknown as typeof globalThis.fetch;
  });

  function buildAdapter(): LlmProviderAdapter {
    return createLlmProviderAdapter({
      getApiKey: () => 'test-key',
      getModel: () => 'gpt-5.4',
      getBaseUrl: () => 'https://provider.test/v1',
      policy: TEST_POLICY,
      clientOptions: { fetch: transport },
    });
  }

  it('issues no transport request beyond the one provider attempt', async () => {
    const budget = new LlmAttemptBudget(6);
    const adapter = buildAdapter();

    const response = await adapter.chatWithTools(toolChatRequest(budget));

    expect(response.content).toBe('Xin chào');
    expect(budget.attemptsUsed).toBe(1);
    expect(requestsIssued).toBe(budget.attemptsUsed);
  });

  it('issues exactly one transport request behind a scripted 429', async () => {
    respond = rateLimitResponse;
    const budget = new LlmAttemptBudget(6);
    const adapter = buildAdapter();

    await expect(
      adapter.chatWithTools(toolChatRequest(budget)),
    ).rejects.toThrow();

    expect(budget.attemptsUsed).toBe(1);
    expect(requestsIssued).toBe(budget.attemptsUsed);
  });

  it('keeps requests equal to attempts across a failover chain', async () => {
    let call = 0;
    // The first candidate rate-limits; the second serves the completion.
    transport = (async () => {
      requestsIssued += 1;
      call += 1;
      return call === 1 ? rateLimitResponse() : toolCallResponse();
    }) as unknown as typeof globalThis.fetch;

    const failoverPolicy: LlmProviderPolicy = {
      ...TEST_POLICY,
      allowedModels: ['openai:gpt-5.4', 'openai-compatible:gpt-5.4'],
    };
    const entry = (provider: string) => ({
      provider,
      getApiKey: () => (provider === 'openai' ? 'sk-test-key' : 'test-key'),
      getModel: () => 'gpt-5.4',
      getBaseUrl: () => 'https://provider.test/v1',
    });
    const adapter = createFailoverLlmProviderAdapter(
      [entry('openai'), entry('openai-compatible')],
      ['openai', 'openai-compatible'],
      undefined,
      { maxAttempts: 1, clientOptions: { fetch: transport } },
      failoverPolicy,
    );
    const budget = new LlmAttemptBudget(6);

    const response = await adapter.chatWithTools(toolChatRequest(budget));

    expect(response.content).toBe('Xin chào');
    expect(budget.attemptsUsed).toBe(2);
    expect(requestsIssued).toBe(budget.attemptsUsed);
  });

  // The ceiling recorded in docs/llm-fallback-policy.md and docs/adr/0048 is
  // measured here rather than derived, so the number cannot drift from the code.
  it('issues min(N, budget) provider requests under a total outage', async () => {
    respond = rateLimitResponse;
    const order = ['openai', 'openrouter', 'minimax'];
    const policy: LlmProviderPolicy = {
      nodeEnv: 'test',
      allowedBaseUrlHosts: order.map((p) => `${p}.test`),
      allowedModels: order.map((p) => `${p}:gpt-5.4`),
    };
    const adapter = createFailoverLlmProviderAdapter(
      order.map((provider) => ({
        provider,
        getApiKey: () =>
          provider === 'openai'
            ? 'sk-test-key'
            : provider === 'openrouter'
              ? 'sk-or-v1-test'
              : 'test-key',
        getModel: () => 'gpt-5.4',
        getBaseUrl: () => `https://${provider}.test/v1`,
      })),
      order,
      undefined,
      {
        maxAttempts: LLM_EXECUTION_DEFAULTS.retryMaxAttempts,
        clientOptions: { fetch: transport },
      },
      policy,
    );
    const budget = new LlmAttemptBudget(
      LLM_EXECUTION_DEFAULTS.maxTotalProviderAttempts,
    );

    await expect(
      adapter.chatWithTools(toolChatRequest(budget)),
    ).rejects.toThrow();

    expect(budget.attemptsUsed).toBe(
      Math.min(order.length, budget.maxAttempts),
    );
    expect(requestsIssued).toBe(3);
    expect(requestsIssued).toBe(budget.attemptsUsed);
  });
});
