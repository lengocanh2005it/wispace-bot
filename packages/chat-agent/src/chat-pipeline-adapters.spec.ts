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
      userTextParts: ['next', 'question'],
      history,
      correlationId: 'message-1',
    });

    expect(agentService.reply).toHaveBeenCalledWith({
      externalUserId: 'discord-user-1',
      userId: undefined,
      userText: 'next question',
      userTextParts: ['next', 'question'],
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

  it('forwards an enriched tool summary without rewriting it', async () => {
    const toolSummary = [
      '[Đã tra cứu: precreate_next_exercise]',
      '[Kết quả]',
      'precreate_next_exercise: status=created',
      '[Identifiers]',
      'precreate_next_exercise.exerciseUrl=https://wispace.example/exercises/123',
    ].join('\n');
    const agentService = {
      reply: jest.fn().mockResolvedValue({
        text: 'Mình đã tạo bài cho bạn.',
        toolSummary,
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
        userText: 'tạo bài tập mới',
        history: [],
      }),
    ).resolves.toEqual({
      text: 'Mình đã tạo bài cho bạn.',
      toolSummary,
    });
  });

  it('propagates an outbound rate-limit outcome to the shared pipeline', async () => {
    const outboundService = {
      sendText: jest.fn().mockResolvedValue('rate_limited'),
    };
    const adapters = createChatPipelineAdapters(
      {} as never,
      {} as unknown as PlatformChatHistoryService,
      {} as never,
      outboundService,
    );

    await expect(
      adapters.outbound.sendText('discord-user-1', 'hello'),
    ).resolves.toEqual({
      delivered: false,
      outcome: 'rate_limited',
    });
  });
  it('forwards the learner userId to the shared quota service', async () => {
    const rateLimitService = {
      reserve: jest.fn().mockResolvedValue({
        allowed: true,
        usageDate: '2026-06-15',
      }),
    };
    const adapters = createChatPipelineAdapters(
      rateLimitService as never,
      {} as unknown as PlatformChatHistoryService,
      {} as never,
      {} as never,
    );

    await adapters.rateLimiter.reserve('discord-user-1', 'mid-1', {
      userId: 143,
    });

    expect(rateLimitService.reserve).toHaveBeenCalledWith(
      'discord-user-1',
      'mid-1',
      { userId: 143 },
    );
  });
});
