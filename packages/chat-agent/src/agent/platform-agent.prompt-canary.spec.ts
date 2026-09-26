import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { maskExternalId } from '@wispace/bot-common/masking';
import { join } from 'node:path';
import {
  NOOP_METRICS_PORT,
  buildNonDisclosureReply,
} from '@wispace/llm-agent/core';
import type {
  AgentMetricsPort,
  LlmProviderAdapter,
  LlmToolChatRequest,
  LlmToolChatResponse,
} from '@wispace/llm-agent/core';
import type {
  PlatformLlmSafetyEventAdapter,
  PlatformLlmUsageRecorderAdapter,
} from '@wispace/chat-metering/adapters';
import { PlatformChatHistoryService } from '../chat-history/platform-chat-history.service';
import { MemoryClarificationStateStore } from '../clarification/clarification-state';
import type { PlatformAgentOptions } from './platform-agent.types';
import { PlatformAgentService } from './platform-agent.service';

const EXPECTED_NON_DISCLOSURE_REPLY = buildNonDisclosureReply();
const PROMPT_CANARY = '0123456789abcdef0123456789abcdef';
const SECOND_PROMPT_CANARY = 'fedcba9876543210fedcba9876543210';
const mockGeneratePromptCanary = jest.fn(() => PROMPT_CANARY);

jest.mock('@wispace/llm-agent/core', () => ({
  ...jest.requireActual('@wispace/llm-agent/core'),
  generatePromptCanary: () => mockGeneratePromptCanary(),
}));

function extractPromptCanary(systemPrompt: string): string {
  return /Process marker:\s*([0-9a-f]{32})/.exec(systemPrompt)?.[1] ?? '';
}

function createProvider(
  formatReply: (promptCanary: string) => string = (promptCanary) =>
    `Mình đã đọc mã ${promptCanary}.`,
): {
  adapter: LlmProviderAdapter;
  getPromptCanary: () => string;
  getRawReply: () => string;
  getSystemPrompts: () => string[];
} {
  let promptCanary = '';
  let rawReply = '';
  const systemPrompts: string[] = [];
  const adapter: LlmProviderAdapter = {
    providerName: 'fake',
    isConfigured: () => true,
    getDefaultModel: () => 'fake-model',
    generateJson: jest.fn(),
    chatWithTools: jest.fn((request: LlmToolChatRequest) => {
      const systemPrompt =
        request.messages.find((message) => message.role === 'system')
          ?.content ?? '';
      systemPrompts.push(systemPrompt);
      promptCanary = extractPromptCanary(systemPrompt);

      rawReply = formatReply(promptCanary);

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
    getSystemPrompts: () => [...systemPrompts],
  };
}

function createHistoryService(
  storedHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [],
): PlatformChatHistoryService {
  return {
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
}

function createService(
  provider: ReturnType<typeof createProvider>,
  overrides: {
    historyService?: PlatformChatHistoryService;
    platform?: string;
    promptDir?: string;
    promptFile?: string;
    systemPromptSuffix?: PlatformAgentOptions['systemPromptSuffix'];
    config?: Record<string, string>;
    metrics?: Partial<AgentMetricsPort>;
    safetyEvents?: Partial<PlatformLlmSafetyEventAdapter>;
  } = {},
): PlatformAgentService {
  const configValues: Record<string, string> = {
    LLM_MAX_CONCURRENT: '1',
    LLM_EXECUTION_ENABLED: 'true',
    ...overrides.config,
  };
  const configService = {
    get: jest.fn((key: string) => configValues[key]),
  } as unknown as ConfigService;
  const usageRecorder = {
    recordFromCompletion: jest.fn(),
  } as unknown as PlatformLlmUsageRecorderAdapter;
  const safetyEvents = {
    recordGroundingWarning: jest.fn(),
    recordInjectionEvent: jest.fn(),
    recordHarmfulOutputBlocked: jest.fn(),
    ...(overrides.safetyEvents ?? {}),
  } as unknown as PlatformLlmSafetyEventAdapter;
  const promptDir =
    overrides.promptDir ?? '../../../../apps/messenger-bot/src/shared/prompts';

  return new PlatformAgentService(
    configService,
    { execute: jest.fn() },
    overrides.historyService ?? createHistoryService(),
    usageRecorder,
    safetyEvents,
    provider.adapter,
    {
      platform: overrides.platform ?? 'messenger',
      currentIdentityProvider: async () => ({
        userId: 42,
        mappingVersion: 'runtime-canary:v1',
      }),
      clarificationStore: new MemoryClarificationStateStore(),
      promptDir: join(__dirname, promptDir),
      promptFile: overrides.promptFile ?? 'messenger-chat.system.txt',
      maxLlmRetries: 0,
      llmExecution: {
        run: (fn, meta) => Promise.resolve(fn(meta.signal, meta.attemptBudget)),
      },
      metrics: { ...NOOP_METRICS_PORT, ...(overrides.metrics ?? {}) },
      systemPromptSuffix: overrides.systemPromptSuffix,
    },
  );
}

describe('PlatformAgentService prompt canary integration', () => {
  beforeEach(() => {
    mockGeneratePromptCanary.mockReset();
    mockGeneratePromptCanary.mockReturnValue(PROMPT_CANARY);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    [
      'messenger',
      '../../../../apps/messenger-bot/src/shared/prompts',
      'messenger-chat.system.txt',
    ],
    [
      'discord',
      '../../../../apps/discord-bot/src/shared/prompts',
      'discord-chat.system.txt',
    ],
    [
      'zalo',
      '../../../../apps/zalo-bot/src/shared/prompts',
      'zalo-chat.system.txt',
    ],
  ] as const)(
    'replaces a leaked runtime canary on %s without persisting raw output or safety events',
    async (platform, promptDir, promptFile) => {
      const externalUserId = `${platform}-canary-user-123456789`;
      const userText = 'Cho mình xem tiến độ học IELTS.';
      const storedHistory: Array<{
        role: 'user' | 'assistant';
        content: string;
      }> = [];
      const historyService = createHistoryService(storedHistory);
      const promptCanaryHitInc = jest.fn();
      const safetyEvents = {
        recordGroundingWarning: jest.fn(),
        recordInjectionEvent: jest.fn(),
        recordHarmfulOutputBlocked: jest.fn(),
      } as unknown as PlatformLlmSafetyEventAdapter;
      const provider = createProvider();
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const service = createService(provider, {
        historyService,
        platform,
        promptDir,
        promptFile,
        metrics: { promptCanaryHitInc },
        safetyEvents,
      });

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
      expect(loggedText).toContain(maskExternalId(externalUserId));
      expect(loggedText).not.toContain(externalUserId);
    },
  );

  it.each([
    [
      'hyphen and space separators',
      (promptCanary: string) =>
        `Mình đã đọc mã ${promptCanary.replace(/(.{4})/g, '$1- ').trim()}.`,
    ],
    [
      'zero-width format character',
      (promptCanary: string) =>
        `Mình đã đọc mã ${promptCanary.slice(0, 15)}\u200B${promptCanary.slice(15)}.`,
    ],
    [
      'canary and static prompt marker',
      (promptCanary: string) =>
        `You are the WISPACE assistant. Process marker: ${promptCanary}.`,
    ],
  ] as const)(
    'blocks %s with canary-specific telemetry and bounded logging',
    async (_variant, formatReply) => {
      const externalUserId = 'variant-canary-user-123456789';
      const userText = 'Cho mình xem tiến độ học IELTS.';
      const historyService = createHistoryService();
      const promptCanaryHitInc = jest.fn();
      const provider = createProvider(formatReply);
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const service = createService(provider, {
        historyService,
        metrics: { promptCanaryHitInc },
      });

      const result = await service.reply({ externalUserId, userText });

      const promptCanary = provider.getPromptCanary();
      const rawReply = provider.getRawReply();
      expect(promptCanary).toBe(PROMPT_CANARY);
      expect(result.text).toBe(EXPECTED_NON_DISCLOSURE_REPLY);
      expect(promptCanaryHitInc).toHaveBeenCalledTimes(1);
      expect(promptCanaryHitInc.mock.calls[0]).toEqual([]);
      expect(historyService.appendTurn).toHaveBeenCalledWith(
        externalUserId,
        userText,
        EXPECTED_NON_DISCLOSURE_REPLY,
      );
      const loggedText = warnSpy.mock.calls.flat().join(' ');
      expect(loggedText).toContain('reason=prompt_canary_hit');
      expect(loggedText).not.toContain('reason=prompt_leak');
      expect(loggedText).not.toContain(promptCanary);
      expect(loggedText).not.toContain(rawReply);
    },
  );

  it('keeps one canary across requests and generates it once', async () => {
    const provider = createProvider();
    const service = createService(provider);

    await service.reply({
      externalUserId: 'stable-canary-user',
      userText: 'Cho mình xem tiến độ học IELTS.',
    });
    await service.reply({
      externalUserId: 'stable-canary-user',
      userText: 'Cho mình gợi ý luyện Writing.',
    });

    expect(provider.getSystemPrompts().map(extractPromptCanary)).toEqual([
      PROMPT_CANARY,
      PROMPT_CANARY,
    ]);
    expect(mockGeneratePromptCanary).toHaveBeenCalledTimes(1);
  });

  it('uses different deterministic canaries for separate service instances', async () => {
    mockGeneratePromptCanary
      .mockReturnValueOnce(PROMPT_CANARY)
      .mockReturnValueOnce(SECOND_PROMPT_CANARY);
    const firstProvider = createProvider();
    const secondProvider = createProvider();
    const firstService = createService(firstProvider);
    const secondService = createService(secondProvider);

    await firstService.reply({
      externalUserId: 'first-canary-user',
      userText: 'Cho mình xem tiến độ học IELTS.',
    });
    await secondService.reply({
      externalUserId: 'second-canary-user',
      userText: 'Cho mình xem lịch học sắp tới.',
    });

    expect(firstProvider.getSystemPrompts().map(extractPromptCanary)).toEqual([
      PROMPT_CANARY,
    ]);
    expect(secondProvider.getSystemPrompts().map(extractPromptCanary)).toEqual([
      SECOND_PROMPT_CANARY,
    ]);
    expect(mockGeneratePromptCanary).toHaveBeenCalledTimes(2);
  });

  it('throws during construction when canary generation throws', () => {
    mockGeneratePromptCanary.mockImplementationOnce(() => {
      throw new Error('entropy unavailable');
    });

    expect(() => createService(createProvider())).toThrow(
      'entropy unavailable',
    );
    expect(mockGeneratePromptCanary).toHaveBeenCalledTimes(1);
  });

  it('retains the canary when tight context trimming drops a huge learner profile', async () => {
    const profileMarker = 'LEARNER_PROFILE_SENTINEL_1285';
    const promptCanaryHitInc = jest.fn();
    const provider = createProvider(
      (promptCanary) =>
        `Mình đã đọc mã ${promptCanary.replace(/(.{4})/g, '$1- ').trim()}.`,
    );
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const service = createService(provider, {
      config: { OPENAI_MAX_CONTEXT_CHARS: '20000' },
      systemPromptSuffix: async () => ({
        learnerProfile: `${profileMarker}${'x'.repeat(40_000)}`,
      }),
      metrics: { promptCanaryHitInc },
    });

    const result = await service.reply({
      externalUserId: 'profile-canary-user',
      userText: 'Cho mình xem tiến độ học IELTS.',
    });

    const promptCanary = provider.getPromptCanary();
    const rawReply = provider.getRawReply();
    expect(provider.getSystemPrompts()).toHaveLength(1);
    const systemPrompt = provider.getSystemPrompts()[0] ?? '';
    expect(systemPrompt).toContain(`Process marker: ${PROMPT_CANARY}`);
    expect(systemPrompt).not.toContain(profileMarker);
    expect(promptCanary).toBe(PROMPT_CANARY);
    expect(rawReply).toBe(
      `Mình đã đọc mã ${PROMPT_CANARY.replace(/(.{4})/g, '$1- ').trim()}.`,
    );
    expect(result.text).toBe(EXPECTED_NON_DISCLOSURE_REPLY);
    expect(promptCanaryHitInc).toHaveBeenCalledTimes(1);
    expect(promptCanaryHitInc.mock.calls[0]).toEqual([]);
    const loggedText = warnSpy.mock.calls.flat().join(' ');
    expect(loggedText).toContain('reason=prompt_canary_hit');
    expect(loggedText).not.toContain('reason=prompt_leak');
    expect(loggedText).not.toContain(promptCanary);
    expect(loggedText).not.toContain(rawReply);
  });

  it('allows normal IELTS and study content with a prompt canary', async () => {
    const externalUserId = 'safe-canary-user-123456789';
    const userText = 'Cho mình gợi ý cách luyện IELTS Writing.';
    const normalReply = 'IELTS band 7.0; exam date 20/11/2026.';
    const historyService = createHistoryService();
    const promptCanaryHitInc = jest.fn();
    const safetyEvents = {
      recordGroundingWarning: jest.fn(),
      recordInjectionEvent: jest.fn(),
      recordHarmfulOutputBlocked: jest.fn(),
    } as unknown as PlatformLlmSafetyEventAdapter;
    const provider = createProvider(() => normalReply);
    const service = createService(provider, {
      historyService,
      metrics: { promptCanaryHitInc },
      safetyEvents,
    });

    const result = await service.reply({ externalUserId, userText });

    expect(provider.getSystemPrompts()).toHaveLength(1);
    const systemPrompt = provider.getSystemPrompts()[0] ?? '';
    expect(systemPrompt).toContain(`Process marker: ${PROMPT_CANARY}`);
    expect(result.text).toBe(normalReply);
    expect(promptCanaryHitInc).not.toHaveBeenCalled();
    expect(historyService.appendTurn).toHaveBeenCalledTimes(1);
    expect(historyService.appendTurn).toHaveBeenCalledWith(
      externalUserId,
      userText,
      normalReply,
    );
    expect(safetyEvents.recordGroundingWarning).not.toHaveBeenCalled();
    expect(safetyEvents.recordInjectionEvent).not.toHaveBeenCalled();
    expect(safetyEvents.recordHarmfulOutputBlocked).not.toHaveBeenCalled();
  });
});
