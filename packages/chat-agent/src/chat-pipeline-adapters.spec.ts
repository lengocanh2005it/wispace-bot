/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import type { PlatformAgentService } from './agent/platform-agent.service';
import type { PlatformChatHistoryService } from './chat-history/platform-chat-history.service';
import { createChatPipelineAdapters } from './chat-pipeline-adapters';

describe('createChatPipelineAdapters', () => {
  it('forwards preloaded history to the platform agent', async () => {
    const history = [
      { role: 'user' as const, content: 'previous question' },
      { role: 'assistant' as const, content: 'previous answer' },
    ];
    const agentService = {
      reply: jest.fn().mockResolvedValue({ text: 'next answer' }),
    } as unknown as PlatformAgentService;

    const adapters = createChatPipelineAdapters(
      {} as never,
      {} as unknown as PlatformChatHistoryService,
      agentService,
      {} as never,
    );

    await adapters.agent.reply({
      externalUserId: 'discord-user-1',
      userText: 'next question',
      history,
      correlationId: 'message-1',
    });

    expect(agentService.reply).toHaveBeenCalledWith({
      externalUserId: 'discord-user-1',
      userId: undefined,
      userText: 'next question',
      correlationId: 'message-1',
      history,
    });
  });

  it('preserves private-data metadata from the platform agent', async () => {
    const agentService = {
      reply: jest.fn().mockResolvedValue({
        text: 'private answer',
        privateDataFetched: true,
      }),
    } as unknown as PlatformAgentService;

    const adapters = createChatPipelineAdapters(
      {} as never,
      {} as unknown as PlatformChatHistoryService,
      agentService,
      {} as never,
    );

    await expect(
      adapters.agent.reply({
        externalUserId: 'discord-user-1',
        userText: 'tạo bài tập cho mình',
        history: [],
      }),
    ).resolves.toEqual({ text: 'private answer', privateDataFetched: true });
  });
});
