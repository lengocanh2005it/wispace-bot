import { LlmAgentService } from '../agent.service';
import { NOOP_METRICS_PORT, type AgentMetricsPort } from '../ports';
import type { LlmProviderAdapter } from '../provider/llm-provider.adapter';
import type {
  LlmJsonResponse,
  LlmToolChatRequest,
  LlmToolChatResponse,
} from '../provider/types';
import { FailoverLlmProviderAdapter } from '../provider/failover/failover-adapter';
import {
  createEnvLlmExecutionPort,
  type EnvLlmExecutionConfig,
} from './env-llm-execution.port';

function toolResponse(): LlmToolChatResponse {
  return {
    message: {
      role: 'assistant',
      toolCalls: [
        {
          id: 'call-1',
          name: 'list_study_calendar_entries',
          arguments: '{"timeRange":"upcoming","limit":1}',
        },
      ],
    },
    metadata: {
      provider: 'provider-b',
      model: 'model-provider-b',
      responseId: 'response-6',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    },
  };
}

function makeCandidate(
  name: string,
  calls: { total: number; byProvider: Record<string, number> },
): LlmProviderAdapter {
  const fail = new Error('provider outage');
  return {
    providerName: name,
    isConfigured: () => true,
    getDefaultModel: () => `model-${name}`,
    generateJson: async (): Promise<LlmJsonResponse> => {
      throw fail;
    },
    chatWithTools: async (request: LlmToolChatRequest) => {
      request.attemptBudget?.consume();
      calls.total += 1;
      calls.byProvider[name] = (calls.byProvider[name] ?? 0) + 1;
      // The sixth call recovers with a tool response. The next agent round
      // must still stop because the same generation has no allowance left.
      if (calls.total === 6) return toolResponse();
      throw fail;
    },
    isRetryableError: () => true,
    isRateLimitError: () => false,
    normalizeError: () => ({
      provider: name,
      retryable: true,
      reason: 'server_error',
      status: 500,
    }),
  };
}

describe('shared provider-attempt budget integration', () => {
  it('caps a multi-round generation before failover can call the next provider', async () => {
    const calls = { total: 0, byProvider: {} as Record<string, number> };
    const provider = new FailoverLlmProviderAdapter(
      [
        makeCandidate('provider-a', calls),
        makeCandidate('provider-b', calls),
        makeCandidate('provider-c', calls),
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
    const executionConfig: EnvLlmExecutionConfig = {
      enabled: true,
      maxConcurrent: 1,
      globalMaxConcurrent: 1,
      maxAttempts: 8,
      maxTotalProviderAttempts: 6,
      baseBackoffMs: 1,
      retryMaxDelayMs: 1,
      requestTimeoutMs: 5_000,
      perAttemptTimeoutMs: 2_000,
      globalConcurrencyEnabled: false,
      maxQueueDepth: 1,
      chatAdmissionWaitMs: 100,
      backgroundAdmissionWaitMs: 100,
    };
    const totalAttempts = jest.fn();
    const execution = createEnvLlmExecutionPort(
      executionConfig,
      provider,
      { warn: jest.fn() },
      {
        incrementCounter: jest.fn(),
        observeWaitSeconds: jest.fn(),
        observeRetryAttempts: jest.fn(),
        observeTotalProviderAttempts: totalAttempts,
      },
    );
    const metrics: AgentMetricsPort = {
      ...NOOP_METRICS_PORT,
      totalProviderAttemptsInc: jest.fn(),
    };
    const service = new LlmAgentService(
      {
        maxLlmRetries: 0,
        maxToolRounds: 2,
        maxTotalProviderAttempts: 6,
      },
      {
        llmExecution: execution,
        adapter: provider,
        metrics,
        usageRecorder: { recordFromCompletion: jest.fn() },
        safetyEvents: {
          recordGroundingWarning: jest.fn(),
          recordInjectionEvent: jest.fn(),
        },
        toolExecutor: {
          execute: jest.fn().mockResolvedValue({ entries: [] }),
        },
      },
    );

    await expect(
      service.reply(
        {
          externalUserId: 'external-user',
          userText: 'xem lịch học',
          systemPrompt: 'system',
        },
        { externalUserId: 'external-user' },
      ),
    ).rejects.toThrow('provider outage');

    expect(calls.total).toBe(6);
    expect(calls.byProvider).toEqual({
      'provider-a': 3,
      'provider-b': 3,
    });
    expect(calls.byProvider['provider-c']).toBeUndefined();
    expect(totalAttempts).not.toHaveBeenCalled();
    expect(metrics.totalProviderAttemptsInc).toHaveBeenCalledWith(
      'FREE_FORM_CHAT',
      6,
      'budget_exhausted',
    );
  });
});
