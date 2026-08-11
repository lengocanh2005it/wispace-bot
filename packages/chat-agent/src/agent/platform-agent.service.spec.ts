/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import { ConfigService } from '@nestjs/config';
import type { LlmProviderAdapter } from '@wispace/llm-agent';
import type {
  PlatformLlmSafetyEventAdapter,
  PlatformLlmUsageRecorderAdapter,
} from '@wispace/chat-metering';
import type { PlatformChatHistoryService } from '../chat-history/platform-chat-history.service';
import type { PlatformAgentToolsService } from './platform-agent-tools.service';
import { PlatformAgentService } from './platform-agent.service';

const mockLlmReply = jest.fn();

jest.mock('@wispace/llm-agent', () => ({
  LlmAgentService: jest.fn().mockImplementation(() => ({
    reply: mockLlmReply,
  })),
  NOOP_METRICS_PORT: {},
  loadSystemPromptFile: jest.fn().mockReturnValue('system prompt'),
  retryWithBackoff: jest.fn(),
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
});
