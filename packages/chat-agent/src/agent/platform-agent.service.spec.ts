/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import { ConfigService } from '@nestjs/config';
import type { LlmProviderAdapter } from '@wispace/llm-agent';
import type {
  PlatformLlmSafetyEventAdapter,
  PlatformLlmUsageRecorderAdapter,
} from '@wispace/chat-metering';
import { ChatPipeline } from '@wispace/chat-pipeline';
import type { PlatformChatHistoryService } from '../chat-history/platform-chat-history.service';
import type { PlatformAgentToolsService } from './platform-agent-tools.service';
import { PlatformAgentService } from './platform-agent.service';
import { createChatPipelineAdapters } from '../chat-pipeline-adapters';

const mockLlmReply = jest.fn();

jest.mock('@wispace/llm-agent', () => ({
  LlmAgentService: jest.fn().mockImplementation(() => ({
    reply: mockLlmReply,
  })),
  NOOP_METRICS_PORT: {},
  loadSystemPromptFile: jest.fn().mockReturnValue('system prompt'),
  retryWithBackoff: jest.fn(),
  createEnvLlmExecutionPort: jest.fn(),
}));

describe('PlatformAgentService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLlmReply.mockResolvedValue({ text: 'next answer' });
  });

  function buildService(historyService: PlatformChatHistoryService) {
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
      { promptDir: '/prompts', promptFile: 'chat.system.txt' },
    );
  }

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

  it('appends the exact exercise URL when the final LLM text omits it', async () => {
    const exerciseUrl =
      'https://testfrontend.aihubproduction.com/my-roadmap?sequenceIndex=8';
    mockLlmReply.mockImplementation(
      (_request: unknown, context: { precreatedExerciseUrl?: string }) => {
        context.precreatedExerciseUrl = exerciseUrl;
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
});
