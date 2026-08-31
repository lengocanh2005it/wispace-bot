/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmAgentService } from '@wispace/llm-agent';
import type { AgentMetricsPort, LlmProviderAdapter } from '@wispace/llm-agent';
import type {
  PlatformLlmSafetyEventAdapter,
  PlatformLlmUsageRecorderAdapter,
} from '@wispace/chat-metering';
import { ChatPipeline } from '@wispace/chat-pipeline';
import type { PlatformChatHistoryService } from '../chat-history/platform-chat-history.service';
import type { PlatformAgentToolsService } from './platform-agent-tools.service';
import { PlatformAgentService } from './platform-agent.service';
import { createChatPipelineAdapters } from '../chat-pipeline-adapters';
import type {
  ClarificationState,
  ClarificationStateStore,
} from '../clarification/clarification-state';

const mockLlmReply = jest.fn();

jest.mock('@wispace/llm-agent', () => ({
  ...jest.requireActual('@wispace/llm-agent'),
  CHAT_SYSTEM_PROMPT_CORE: 'core prompt',
  LlmAgentService: jest.fn().mockImplementation(() => ({
    reply: mockLlmReply,
  })),
  loadSystemPromptFile: jest.fn().mockReturnValue('system prompt'),
  retryWithBackoff: jest.fn(),
  createEnvLlmExecutionPort: jest.fn(),
}));

describe('PlatformAgentService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLlmReply.mockResolvedValue({ text: 'next answer' });
  });

  function buildService(
    historyService: PlatformChatHistoryService,
    overrides: {
      clarificationStore?: ClarificationStateStore;
      platform?: string;
      clarificationOutcomeInc?: (outcome: string) => void;
      metrics?: AgentMetricsPort;
      currentIdentityProvider?: (
        externalUserId: string,
      ) => Promise<{ userId: number; mappingVersion: string } | undefined>;
      systemPromptSuffix?: () => Promise<string | undefined>;
    } = {},
  ) {
    const config = {
      get: jest.fn((key: string) =>
        key === 'LLM_MAX_CONCURRENT' ? '1' : undefined,
      ),
    } as unknown as ConfigService;

    return new PlatformAgentService(
      config,
      {} as unknown as PlatformAgentToolsService,
      historyService,
      {} as unknown as PlatformLlmUsageRecorderAdapter,
      {} as unknown as PlatformLlmSafetyEventAdapter,
      {} as unknown as LlmProviderAdapter,
      {
        promptDir: '/prompts',
        promptFile: 'chat.system.txt',
        platform: overrides.platform,
        currentIdentityProvider:
          overrides.currentIdentityProvider ??
          (async () => ({
            userId: 42,
            mappingVersion: 'test:platform-agent',
          })),
        clarificationStore: overrides.clarificationStore,
        clarificationOutcomeInc: overrides.clarificationOutcomeInc,
        metrics: overrides.metrics,
        systemPromptSuffix: overrides.systemPromptSuffix,
      },
    );
  }

  function buildClarificationStore() {
    const states = new Map<string, ClarificationState>();
    const store: ClarificationStateStore = {
      get: jest.fn(async (key) => states.get(key) ?? null),
      set: jest.fn(async (key, next, expectedVersion) => {
        const currentVersion = states.get(key)?.version ?? 0;
        if (
          expectedVersion !== undefined &&
          expectedVersion !== currentVersion
        ) {
          return false;
        }
        states.set(key, next);
        return true;
      }),
      clear: jest.fn(async (key, expectedVersion) => {
        const state = states.get(key);
        if (
          expectedVersion !== undefined &&
          (!state || state.version !== expectedVersion)
        ) {
          return false;
        }
        states.delete(key);
        return true;
      }),
    };
    return store;
  }

  it('composes the shared chat core with the platform overlay', async () => {
    const historyService = {
      getHistory: jest.fn().mockResolvedValue([]),
      appendTurn: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformChatHistoryService;
    const service = buildService(historyService);

    await service.reply({
      externalUserId: 'zalo-user-1',
      userText: 'next question',
    });

    expect(mockLlmReply).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: 'core prompt\n\nsystem prompt',
      }),
      expect.anything(),
    );
  });

  it('composes the system prompt through the shared composer — runtime output is byte-identical to the harness path (#646)', async () => {
    const { composeChatSystemPrompt: realCompose } =
      jest.requireActual<typeof import('@wispace/llm-agent')>(
        '@wispace/llm-agent',
      );
    const historyService = {
      getHistory: jest.fn().mockResolvedValue([]),
      appendTurn: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformChatHistoryService;
    const service = buildService(historyService, {
      systemPromptSuffix: async () => 'linkage suffix',
    });

    await service.reply({
      externalUserId: 'zalo-user-1',
      userText: 'next question',
    });

    // The runtime sees the mocked module's core ('core prompt') and overlay
    // ('system prompt') — the shared composer must produce exactly what the
    // service sends, including the suffix block.
    expect(mockLlmReply).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: realCompose({
          core: 'core prompt',
          overlay: 'system prompt',
          suffix: 'linkage suffix',
        }),
      }),
      expect.anything(),
    );
  });

  it('redacts credential-shaped content in the system prompt suffix — no-secrets zone (#632)', async () => {
    const historyService = {
      getHistory: jest.fn().mockResolvedValue([]),
      appendTurn: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformChatHistoryService;
    const service = buildService(historyService, {
      systemPromptSuffix: async () =>
        'Learner facts: target 7.0, token Bearer abcdef1234567890abcd leaked here',
    });

    await service.reply({
      externalUserId: 'zalo-user-1',
      userText: 'next question',
    });

    const call = mockLlmReply.mock.calls[0][0] as { systemPrompt: string };
    expect(call.systemPrompt).toContain('Learner facts: target 7.0');
    expect(call.systemPrompt).not.toContain('abcdef1234567890abcd');
    expect(call.systemPrompt).toContain('[REDACTED]');
  });

  it('routes every platform through the shared agent loop (#414)', async () => {
    const historyService = {
      getHistory: jest.fn().mockResolvedValue([]),
      appendTurn: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformChatHistoryService;

    for (const platform of ['messenger', 'discord', 'zalo']) {
      const service = buildService(historyService, {
        platform,
      });
      await service.reply({
        externalUserId: `${platform}-user`,
        userText: 'Xem tiến độ học của mình',
      });
    }

    const constructorCalls = (LlmAgentService as unknown as jest.Mock).mock
      .calls;
    expect(constructorCalls).toHaveLength(3);
  });

  it('bounds an ambiguous turn without invoking the LLM, then maps an active choice to a fresh intent', async () => {
    const historyService = {
      getHistory: jest.fn().mockResolvedValue([]),
      appendTurn: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformChatHistoryService;
    const clarificationStore = buildClarificationStore();
    const service = buildService(historyService, { clarificationStore });

    const first = await service.reply({
      externalUserId: 'zalo-user-1',
      userText: '1',
    });

    expect(first.text).toContain('Tiến độ học');
    expect(mockLlmReply).not.toHaveBeenCalled();

    await service.reply({
      externalUserId: 'zalo-user-1',
      userText: '1',
    });

    expect(mockLlmReply).toHaveBeenCalledWith(
      expect.objectContaining({
        userText: expect.stringMatching(/tiến độ học/i),
      }),
      expect.anything(),
    );
    expect(clarificationStore.set).toHaveBeenCalledWith(
      'default:zalo-user-1',
      expect.objectContaining({ phase: 'consumed' }),
      expect.any(Number),
    );
  });

  it('tombstones stale clarification state before a clear new question', async () => {
    const historyService = {
      getHistory: jest.fn().mockResolvedValue([]),
      appendTurn: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformChatHistoryService;
    const clarificationStore = buildClarificationStore();
    const service = buildService(historyService, { clarificationStore });

    await service.reply({
      externalUserId: 'zalo-user-1',
      userText: 'abc???',
    });
    await service.reply({
      externalUserId: 'zalo-user-1',
      userText: 'Xem tiến độ học của mình',
    });

    expect(clarificationStore.set).toHaveBeenCalledWith(
      'default:zalo-user-1',
      expect.objectContaining({ phase: 'consumed' }),
      1,
    );
    expect(mockLlmReply).toHaveBeenCalledWith(
      expect.objectContaining({ userText: 'Xem tiến độ học của mình' }),
      expect.anything(),
    );
  });

  it('returns the non-text fallback for emoji-only input without creating state', async () => {
    const historyService = {
      getHistory: jest.fn().mockResolvedValue([]),
      appendTurn: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformChatHistoryService;
    const clarificationStore = buildClarificationStore();
    const service = buildService(historyService, { clarificationStore });

    const result = await service.reply({
      externalUserId: 'zalo-user-1',
      userText: '😀👍',
    });

    expect(result.text).toContain('tin nhắn chữ');
    expect(clarificationStore.set).not.toHaveBeenCalled();
    expect(mockLlmReply).not.toHaveBeenCalled();
  });

  it('does not emit a second clarification reply for a replayed event', async () => {
    const historyService = {
      getHistory: jest.fn().mockResolvedValue([]),
      appendTurn: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformChatHistoryService;
    const clarificationStore = buildClarificationStore();
    const service = buildService(historyService, { clarificationStore });

    const first = await service.reply({
      externalUserId: 'zalo-user-1',
      userText: 'abc???',
      correlationId: 'event-401-1',
    });
    const replay = await service.reply({
      externalUserId: 'zalo-user-1',
      userText: 'abc???',
      correlationId: 'event-401-1',
    });

    expect(replay.text).toBe(first.text);
    expect(replay.skipDelivery).toBe(true);
    expect(mockLlmReply).not.toHaveBeenCalled();
    expect(clarificationStore.set).toHaveBeenCalledTimes(1);
  });

  it('blocks an out-of-order clarification event from executing a tool', async () => {
    const historyService = {
      getHistory: jest.fn().mockResolvedValue([]),
      appendTurn: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformChatHistoryService;
    const clarificationStore = buildClarificationStore();
    const service = buildService(historyService, { clarificationStore });

    await service.reply({
      externalUserId: 'zalo-user-1',
      userText: 'abc???',
      correlationId: 'event-a',
    });
    await service.reply({
      externalUserId: 'zalo-user-1',
      userText: 'thời tiết',
      correlationId: 'event-b',
    });
    const stale = await service.reply({
      externalUserId: 'zalo-user-1',
      userText: '3',
      correlationId: 'event-a',
    });

    expect(stale.clarification).toBe(true);
    expect(stale.skipDelivery).toBe(true);
    expect(mockLlmReply).not.toHaveBeenCalled();
  });

  it('keeps a consumed clarification tombstone so a concurrent choice cannot call tools twice', async () => {
    const historyService = {
      getHistory: jest.fn().mockResolvedValue([]),
      appendTurn: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformChatHistoryService;
    const clarificationStore = buildClarificationStore();
    const service = buildService(historyService, { clarificationStore });

    await service.reply({
      externalUserId: 'zalo-user-1',
      userText: 'abc???',
      correlationId: 'event-menu',
    });
    await service.reply({
      externalUserId: 'zalo-user-1',
      userText: '1',
      correlationId: 'event-choice-1',
    });
    const secondChoice = await service.reply({
      externalUserId: 'zalo-user-1',
      userText: '3',
      correlationId: 'event-choice-2',
    });

    expect(secondChoice.clarification).toBe(true);
    expect(mockLlmReply).toHaveBeenCalledTimes(1);
  });

  it('reopens a clarification after a known failed delivery for that event', async () => {
    const historyService = {
      getHistory: jest.fn().mockResolvedValue([]),
      appendTurn: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformChatHistoryService;
    const clarificationStore = buildClarificationStore();
    const service = buildService(historyService, { clarificationStore });

    const first = await service.reply({
      externalUserId: 'zalo-user-1',
      userText: 'abc???',
      correlationId: 'event-401-failed',
    });
    await service.markClarificationDeliveryFailedForEvent(
      'zalo-user-1',
      'event-401-failed',
    );
    const retry = await service.reply({
      externalUserId: 'zalo-user-1',
      userText: 'abc???',
      correlationId: 'event-401-failed',
    });

    expect(first.skipDelivery).toBeUndefined();
    expect(retry.skipDelivery).toBeUndefined();
    expect(clarificationStore.set).toHaveBeenCalledWith(
      'default:zalo-user-1',
      expect.objectContaining({ lastDeliveryFailed: true }),
      expect.any(Number),
    );
    expect(clarificationStore.set).toHaveBeenCalledTimes(3);
  });

  it('cancel clears the pending state without invoking tools', async () => {
    const historyService = {
      getHistory: jest.fn().mockResolvedValue([]),
      appendTurn: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformChatHistoryService;
    const clarificationStore = buildClarificationStore();
    const service = buildService(historyService, { clarificationStore });

    await service.reply({
      externalUserId: 'zalo-user-1',
      userText: 'abc???',
      correlationId: 'event-401-start',
    });
    const cancelled = await service.reply({
      externalUserId: 'zalo-user-1',
      userText: 'bỏ qua',
      correlationId: 'event-401-cancel',
    });

    expect(cancelled.text).toContain('Đã hủy');
    expect(clarificationStore.get).toHaveBeenLastCalledWith(
      'default:zalo-user-1',
    );
    await expect(
      clarificationStore.get('default:zalo-user-1'),
    ).resolves.toBeNull();
    expect(mockLlmReply).not.toHaveBeenCalled();
  });

  it('answers a cancellation safely when no clarification is pending', async () => {
    const historyService = {
      getHistory: jest.fn().mockResolvedValue([]),
      appendTurn: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformChatHistoryService;
    const service = buildService(historyService, {
      clarificationStore: buildClarificationStore(),
    });

    const result = await service.reply({
      externalUserId: 'zalo-user-1',
      userText: 'cancel',
    });

    expect(result.text).toContain('Đã hủy');
    expect(mockLlmReply).not.toHaveBeenCalled();
  });

  it('namespaces the same external id by platform', async () => {
    const historyService = {
      getHistory: jest.fn().mockResolvedValue([]),
      appendTurn: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformChatHistoryService;
    const clarificationStore = buildClarificationStore();
    const discord = buildService(historyService, {
      clarificationStore,
      platform: 'discord',
    });
    const zalo = buildService(historyService, {
      clarificationStore,
      platform: 'zalo',
    });

    await discord.reply({ externalUserId: 'same-id', userText: 'abc???' });
    await zalo.reply({ externalUserId: 'same-id', userText: 'abc???' });
    await discord.reply({ externalUserId: 'same-id', userText: '1' });
    await zalo.reply({ externalUserId: 'same-id', userText: '2' });

    expect(mockLlmReply).toHaveBeenCalledTimes(2);
  });

  it('resets and then clears an irrelevant clarification loop at its bound', async () => {
    const historyService = {
      getHistory: jest.fn().mockResolvedValue([]),
      appendTurn: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformChatHistoryService;
    const clarificationStore = buildClarificationStore();
    const service = buildService(historyService, { clarificationStore });

    for (let i = 0; i < 7; i += 1) {
      await service.reply({
        externalUserId: 'zalo-user-1',
        userId: 42,
        userText: 'thời tiết',
        correlationId: `event-401-offtopic-${i}`,
      });
    }

    await expect(
      clarificationStore.get('default:zalo-user-1'),
    ).resolves.toBeNull();
    expect(mockLlmReply).not.toHaveBeenCalled();
  });

  it('fails closed when clarification storage is unavailable', async () => {
    const historyService = {
      getHistory: jest.fn().mockResolvedValue([]),
      appendTurn: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformChatHistoryService;
    const clarificationStore: ClarificationStateStore = {
      get: jest.fn().mockRejectedValue(new Error('store unavailable')),
      set: jest.fn(),
      clear: jest.fn(),
    };
    const service = buildService(historyService, { clarificationStore });

    const result = await service.reply({
      externalUserId: 'zalo-user-1',
      userText: 'tiến độ',
    });

    expect(result.text).toContain('chưa thể xử lý');
    expect(result.skipHistory).toBe(true);
    expect(mockLlmReply).not.toHaveBeenCalled();
  });

  it('records bounded degraded telemetry for clarification storage failure', async () => {
    const historyService = {
      getHistory: jest.fn().mockResolvedValue([]),
      appendTurn: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformChatHistoryService;
    const clarificationStore: ClarificationStateStore = {
      get: jest.fn().mockRejectedValue(new Error('store unavailable')),
      set: jest.fn(),
      clear: jest.fn(),
    };
    const degradedModeInc = jest.fn();
    const service = buildService(historyService, {
      clarificationStore,
      platform: 'zalo',
      metrics: { degradedModeInc } as AgentMetricsPort,
    });

    await service.reply({
      externalUserId: 'zalo-user-1',
      userText: 'tiến độ',
      correlationId: 'event-clarification-1',
    });

    expect(degradedModeInc).toHaveBeenCalledWith({
      platform: 'zalo',
      feature: 'FREE_FORM_CHAT',
      failureClass: 'history_unavailable',
      action: 'block_response',
      correlationId: 'event-clarification-1',
    });
  });

  it('treats contradictory debounce text as a bounded clarification, not a tool turn', async () => {
    const historyService = {
      getHistory: jest.fn().mockResolvedValue([]),
      appendTurn: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformChatHistoryService;
    const clarificationStore = buildClarificationStore();
    const service = buildService(historyService, { clarificationStore });

    const result = await service.reply({
      externalUserId: 'zalo-user-1',
      userText: 'lich hoc\n3',
      correlationId: 'event-401-2',
    });

    expect(result.text).toContain('Trả lời 1, 2 hoặc 3');
    expect(result.skipHistory).toBe(true);
    expect(mockLlmReply).not.toHaveBeenCalled();
  });

  it('does not append when the pipeline supplied preloaded history', async () => {
    const history = [{ role: 'user' as const, content: 'previous question' }];
    const historyService = {
      getHistory: jest.fn(),
      appendTurn: jest.fn(),
    } as unknown as PlatformChatHistoryService;
    const service = buildService(historyService);

    await service.reply({
      externalUserId: 'zalo-user-1',
      userText: 'next question',
      history,
    });

    expect(historyService.getHistory).not.toHaveBeenCalled();
    expect(historyService.appendTurn).not.toHaveBeenCalled();
    expect(mockLlmReply).toHaveBeenCalledWith(
      expect.objectContaining({ history }),
      expect.anything(),
    );
  });

  it('keeps agent-owned history for callers without preloaded history', async () => {
    const historyService = {
      getHistory: jest.fn().mockResolvedValue([]),
      appendTurn: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformChatHistoryService;
    const service = buildService(historyService);

    await service.reply({
      externalUserId: 'zalo-user-1',
      userText: 'first question',
    });

    expect(historyService.getHistory).toHaveBeenCalledWith('zalo-user-1');
    expect(historyService.appendTurn).toHaveBeenCalledWith(
      'zalo-user-1',
      'first question',
      'next answer',
    );
  });

  it('reloads history when the authoritative mapping generation changes', async () => {
    const historyService = {
      getHistory: jest
        .fn()
        .mockResolvedValue([{ role: 'user', content: 'fresh owner history' }]),
      appendTurn: jest.fn().mockResolvedValue(undefined),
      clear: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformChatHistoryService;
    const currentIdentityProvider = jest
      .fn()
      .mockResolvedValueOnce({ userId: 42, mappingVersion: 'mapping:v1' })
      .mockResolvedValueOnce({ userId: 99, mappingVersion: 'mapping:v2' });
    const service = buildService(historyService, {
      currentIdentityProvider,
    });
    const staleSnapshot = [{ role: 'user' as const, content: 'old owner' }];

    await service.reply({
      externalUserId: 'discord-relinked',
      userText: 'first owner question',
      history: staleSnapshot,
    });
    await service.reply({
      externalUserId: 'discord-relinked',
      userText: 'new owner question',
      history: staleSnapshot,
    });

    expect(historyService.clear).toHaveBeenCalledWith('discord-relinked');
    expect(historyService.getHistory).toHaveBeenCalledWith('discord-relinked');
    expect(mockLlmReply).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        history: [{ role: 'user', content: 'fresh owner history' }],
      }),
      expect.anything(),
    );
  });

  it('appends the exact exercise URL when the final LLM text omits it', async () => {
    const exerciseUrl =
      'https://testfrontend.aihubproduction.com/my-roadmap?sequenceIndex=8';
    mockLlmReply.mockImplementation(
      (
        _request: unknown,
        context: { pinnedFacts?: Array<{ key: string; text: string }> },
      ) => {
        context.pinnedFacts = [
          {
            key: 'precreated_exercise_url',
            text: `Mở bài tập tại đây: ${exerciseUrl}`,
          },
        ];
        return { text: 'Mình đã tạo bài tập tiếp theo cho bạn.' };
      },
    );
    const historyService = {
      getHistory: jest.fn().mockResolvedValue([]),
      appendTurn: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformChatHistoryService;
    const service = buildService(historyService);

    const result = await service.reply({
      externalUserId: 'zalo-user-1',
      userText: 'Tạo bài tập cho mình',
    });

    const expected = `Mình đã tạo bài tập tiếp theo cho bạn.\n\nMở bài tập tại đây: ${exerciseUrl}`;
    expect(result.text).toBe(expected);
    expect(historyService.appendTurn).toHaveBeenCalledWith(
      'zalo-user-1',
      'Tạo bài tập cho mình',
      expected,
    );
  });

  it('keeps one read and one append per turn across the full pipeline', async () => {
    const storedHistory: Array<{
      role: 'user' | 'assistant' | 'tool_summary';
      content: string;
    }> = [];
    const historyService = {
      getHistory: jest.fn(() =>
        Promise.resolve(storedHistory.map((entry) => ({ ...entry }))),
      ),
      appendTurn: jest.fn(
        (_externalUserId: string, userText: string, assistantText: string) => {
          storedHistory.push(
            { role: 'user', content: userText },
            { role: 'assistant', content: assistantText },
          );
          return Promise.resolve();
        },
      ),
    } as unknown as PlatformChatHistoryService;
    const service = buildService(historyService);
    const adapters = createChatPipelineAdapters(
      {
        reserve: jest
          .fn()
          .mockResolvedValue({ allowed: true, usageDate: '2026-08-11' }),
        refund: jest.fn().mockResolvedValue(undefined),
        markDelivered: jest.fn().mockResolvedValue(undefined),
        markCompleted: jest.fn().mockResolvedValue(undefined),
      } as never,
      historyService,
      service,
      {
        sendText: jest.fn().mockResolvedValue({ delivered: true }),
      },
    );
    const pipeline = new ChatPipeline(
      adapters.rateLimiter,
      adapters.history,
      adapters.agent,
      adapters.outbound,
    );
    mockLlmReply
      .mockResolvedValueOnce({ text: 'first answer' })
      .mockResolvedValueOnce({ text: 'second answer' });

    await expect(
      pipeline.flush({
        externalUserId: 'zalo-user-1',
        texts: ['first question'],
        idempotencyKey: 'message-1',
      }),
    ).resolves.toBe(true);
    await expect(
      pipeline.flush({
        externalUserId: 'zalo-user-1',
        texts: ['second question'],
        idempotencyKey: 'message-2',
      }),
    ).resolves.toBe(true);

    expect(historyService.getHistory).toHaveBeenCalledTimes(2);
    expect(historyService.appendTurn).toHaveBeenCalledTimes(2);
    expect(mockLlmReply).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ history: [] }),
      expect.anything(),
    );
    expect(mockLlmReply).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        history: [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'first answer' },
        ],
      }),
      expect.anything(),
    );
    expect(storedHistory).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'second answer' },
    ]);
  });

  it('redacts sensitive data in telemetry: metric labels and logs never contain unmasked external id or raw text', async () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const outcomes: string[] = [];
    const clarificationOutcomeInc = jest.fn((outcome: string) => {
      outcomes.push(outcome);
    });
    const historyService = {
      getHistory: jest.fn().mockResolvedValue([]),
      appendTurn: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformChatHistoryService;
    const failingStore: ClarificationStateStore = {
      get: jest.fn().mockRejectedValue(new Error('store unavailable')),
      set: jest.fn(),
      clear: jest.fn(),
    };
    const rawExternalId = 'unmasked-sensitive-user-9876543210';
    const rawSecretUserText = 'my secret confidential question about scores';

    const service = buildService(historyService, {
      clarificationStore: failingStore,
      clarificationOutcomeInc,
    });

    await service.reply({
      externalUserId: rawExternalId,
      userText: rawSecretUserText,
    });

    // Verify metrics outcomes
    expect(clarificationOutcomeInc).toHaveBeenCalled();
    for (const outcome of outcomes) {
      expect(outcome).not.toContain(rawExternalId);
      expect(outcome).not.toContain(rawSecretUserText);
      expect([
        'blocked_tool',
        'expired',
        'identity_reset',
        'stale_reply',
        'replayed',
        'cancelled',
        'choice',
        'new_question',
        'max_reset',
        'reset_menu',
        'irrelevant_clarify',
        'started_offtopic',
        'started_ambiguous',
        'unavailable',
      ]).toContain(outcome);
    }

    // Verify logs redaction
    expect(errorSpy).toHaveBeenCalled();
    const loggedMessage = errorSpy.mock.calls[0][0] as string;
    expect(loggedMessage).not.toContain(rawExternalId);
    expect(loggedMessage).not.toContain(rawSecretUserText);
    expect(loggedMessage).toContain('unma…3210');

    errorSpy.mockRestore();
  });
});
