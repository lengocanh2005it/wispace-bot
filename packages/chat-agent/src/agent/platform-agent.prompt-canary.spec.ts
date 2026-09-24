import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { join } from 'node:path';
import {
  NOOP_METRICS_PORT,
  buildNonDisclosureReply,
  type LlmProviderAdapter,
  type LlmToolChatRequest,
  type LlmToolChatResponse,
} from '@wispace/llm-agent';
import type {
  PlatformLlmSafetyEventAdapter,
  PlatformLlmUsageRecorderAdapter,
} from '@wispace/chat-metering';
import { PlatformChatHistoryService } from '../chat-history/platform-chat-history.service';
import { MemoryClarificationStateStore } from '../clarification/clarification-state';
import { PlatformAgentService } from './platform-agent.service';

const EXPECTED_NON_DISCLOSURE_REPLY = buildNonDisclosureReply();

function createProvider(): {
  adapter: LlmProviderAdapter;
  getPromptCanary: () => string;
  getRawReply: () => string;
} {
  let promptCanary = '';
  let rawReply = '';
  const adapter: LlmProviderAdapter = {
    providerName: 'fake',
    isConfigured: () => true,
    getDefaultModel: () => 'fake-model',
    generateJson: jest.fn(),
    chatWithTools: jest.fn((request: LlmToolChatRequest) => {
      const systemPrompt =
        request.messages.find((message) => message.role === 'system')
          ?.content ?? '';
      promptCanary =
        /Prompt canary:\s*([0-9a-f]{32})\./.exec(systemPrompt)?.[1] ?? '';
      rawReply = `Mình đã đọc mã ${promptCanary}.`;
      const response: LlmToolChatResponse = {
        message: { role: 'assistant', content: rawReply },
        content: rawReply,
        metadata: {
          provider: 'fake',
          model: 'fake-model',
          responseId: 'fake-response',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
      };
      return Promise.resolve(response);
    }),
    isRetryableError: () => false,
    isRateLimitError: () => false,
    normalizeError: () => ({
      provider: 'fake',
      retryable: false,
      reason: 'unknown',
    }),
  };
  return {
    adapter,
    getPromptCanary: () => promptCanary,
    getRawReply: () => rawReply,
  };
}

describe('PlatformAgentService prompt canary integration', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('replaces a leaked runtime canary without persisting raw output or safety events', async () => {
    const externalUserId = 'runtime-canary-user-123456789';
    const userText = 'Cho mình xem tiến độ học IELTS.';
    const storedHistory: Array<{
      role: 'user' | 'assistant';
      content: string;
    }> = [];
    const historyService = {
      getHistory: jest.fn(async () =>
        storedHistory.map((entry) => ({ ...entry })),
      ),
      appendTurn: jest.fn(
        async (_externalUserId: string, question: string, answer: string) => {
          storedHistory.push(
            { role: 'user', content: question },
            { role: 'assistant', content: answer },
          );
        },
      ),
    } as unknown as PlatformChatHistoryService;
    const usageRecorder = {
      recordFromCompletion: jest.fn(),
    } as unknown as PlatformLlmUsageRecorderAdapter;
    const safetyEvents = {
      recordGroundingWarning: jest.fn(),
      recordInjectionEvent: jest.fn(),
      recordHarmfulOutputBlocked: jest.fn(),
    } as unknown as PlatformLlmSafetyEventAdapter;
    const promptCanaryHitInc = jest.fn();
    const provider = createProvider();
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const configValues: Record<string, string> = {
      LLM_MAX_CONCURRENT: '1',
      LLM_EXECUTION_ENABLED: 'true',
    };
    const configService = {
      get: jest.fn((key: string) => configValues[key]),
    } as unknown as ConfigService;
    const service = new PlatformAgentService(
      configService,
      { execute: jest.fn() },
      historyService,
      usageRecorder,
      safetyEvents,
      provider.adapter,
      {
        platform: 'messenger',
        currentIdentityProvider: async () => ({
          userId: 42,
          mappingVersion: 'runtime-canary:v1',
        }),
        clarificationStore: new MemoryClarificationStateStore(),
        promptDir: join(
          __dirname,
          '../../../../apps/messenger-bot/src/shared/prompts',
        ),
        promptFile: 'messenger-chat.system.txt',
        maxLlmRetries: 0,
        llmExecution: {
          run: (fn, meta) =>
            Promise.resolve(fn(meta.signal, meta.attemptBudget)),
        },
        metrics: {
          ...NOOP_METRICS_PORT,
          promptCanaryHitInc,
        },
      },
    );

    const result = await service.reply({ externalUserId, userText });

    const promptCanary = provider.getPromptCanary();
    const rawReply = provider.getRawReply();
    expect(promptCanary).toMatch(/^[0-9a-f]{32}$/);
    expect(rawReply).toContain(promptCanary);
    expect(result.text).toBe(EXPECTED_NON_DISCLOSURE_REPLY);
    expect(promptCanaryHitInc).toHaveBeenCalledTimes(1);
    expect(promptCanaryHitInc.mock.calls[0]).toEqual([]);
    expect(historyService.appendTurn).toHaveBeenCalledWith(
      externalUserId,
      userText,
      EXPECTED_NON_DISCLOSURE_REPLY,
    );
    expect(JSON.stringify(storedHistory)).not.toContain(promptCanary);
    expect(JSON.stringify(storedHistory)).not.toContain(rawReply);
    expect(safetyEvents.recordGroundingWarning).not.toHaveBeenCalled();
    expect(safetyEvents.recordInjectionEvent).not.toHaveBeenCalled();
    expect(safetyEvents.recordHarmfulOutputBlocked).not.toHaveBeenCalled();
    const loggedText = warnSpy.mock.calls.flat().join(' ');
    expect(loggedText).not.toContain(promptCanary);
    expect(loggedText).not.toContain(rawReply);
    expect(loggedText).not.toContain(externalUserId);
  });
});
