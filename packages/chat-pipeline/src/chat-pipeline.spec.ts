/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Jest mock.calls access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Jest mock.calls access */
import { ChatPipeline } from './chat-pipeline';
import type {
  AgentPort,
  HistoryPort,
  OutboundPort,
  RateLimiterPort,
  ChatPipelineHooks,
} from './types';

function mockRateLimiter(
  overrides?: Partial<RateLimiterPort>,
): RateLimiterPort {
  return {
    reserve: jest
      .fn()
      .mockResolvedValue({ allowed: true, usageDate: '2026-07-29' }),
    refund: jest.fn().mockResolvedValue(undefined),
    markCompleted: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function mockHistory(overrides?: Partial<HistoryPort>): HistoryPort {
  return {
    getHistory: jest.fn().mockResolvedValue([]),
    appendTurn: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function mockAgent(overrides?: Partial<AgentPort>): AgentPort {
  return {
    reply: jest.fn().mockResolvedValue({ text: 'Hello from agent' }),
    ...overrides,
  };
}

function mockOutbound(overrides?: Partial<OutboundPort>): OutboundPort {
  return {
    sendText: jest.fn().mockResolvedValue({ delivered: true }),
    ...overrides,
  };
}

describe('ChatPipeline', () => {
  it('calls reserve → history → agent → append → send → markCompleted', async () => {
    const rateLimiter = mockRateLimiter();
    const history = mockHistory();
    const agent = mockAgent();
    const outbound = mockOutbound();

    const pipeline = new ChatPipeline(rateLimiter, history, agent, outbound);
    const delivered = await pipeline.flush({
      externalUserId: 'user-1',
      texts: ['Hello'],
      idempotencyKey: 'msg-1',
    });

    expect(delivered).toBe(true);
    expect(rateLimiter.reserve).toHaveBeenCalledWith('user-1', 'msg-1', {
      userId: undefined,
    });
    expect(history.getHistory).toHaveBeenCalledWith('user-1');
    expect(agent.reply).toHaveBeenCalledWith(
      expect.objectContaining({ externalUserId: 'user-1', userText: 'Hello' }),
    );
    expect(history.appendTurn).toHaveBeenCalledWith(
      'user-1',
      'Hello',
      'Hello from agent',
    );
    expect(outbound.sendText).toHaveBeenCalledWith(
      'user-1',
      'Hello from agent',
      { userId: undefined },
    );
    expect(rateLimiter.markCompleted).toHaveBeenCalledWith('msg-1');
  });

  it('merges multiple texts with newline', async () => {
    const agent = mockAgent();
    const pipeline = new ChatPipeline(
      mockRateLimiter(),
      mockHistory(),
      agent,
      mockOutbound(),
    );

    await pipeline.flush({
      externalUserId: 'user-1',
      texts: ['Hello', 'World', 'Foo'],
      idempotencyKey: 'msg-1',
    });

    expect(agent.reply).toHaveBeenCalledWith(
      expect.objectContaining({ userText: 'Hello\nWorld\nFoo' }),
    );
  });

  it('caps merged text at mergedTextMaxChars', async () => {
    const agent = mockAgent();
    const pipeline = new ChatPipeline(
      mockRateLimiter(),
      mockHistory(),
      agent,
      mockOutbound(),
      {},
      { mergedTextMaxChars: 10 },
    );

    await pipeline.flush({
      externalUserId: 'user-1',
      texts: ['This is a long message that exceeds the limit'],
      idempotencyKey: 'msg-1',
    });

    expect(agent.reply).toHaveBeenCalledWith(
      expect.objectContaining({ userText: 'This is a ' }),
    );
  });

  it('returns false when reserve is denied', async () => {
    const rateLimiter = mockRateLimiter({
      reserve: jest
        .fn()
        .mockResolvedValue({ allowed: false, reason: 'DAILY_LIMIT' }),
    });
    const agent = mockAgent();
    const outbound = mockOutbound();
    const pipeline = new ChatPipeline(
      rateLimiter,
      mockHistory(),
      agent,
      outbound,
    );

    const delivered = await pipeline.flush({
      externalUserId: 'user-1',
      texts: ['Hello'],
      idempotencyKey: 'msg-1',
    });

    expect(delivered).toBe(false);
    expect(agent.reply).not.toHaveBeenCalled();
    expect(outbound.sendText).not.toHaveBeenCalled();
  });

  it('skips reserve when no idempotencyKey', async () => {
    const rateLimiter = mockRateLimiter();
    const agent = mockAgent();
    const pipeline = new ChatPipeline(
      rateLimiter,
      mockHistory(),
      agent,
      mockOutbound(),
    );

    await pipeline.flush({
      externalUserId: 'user-1',
      texts: ['Hello'],
    });

    expect(rateLimiter.reserve).not.toHaveBeenCalled();
    expect(agent.reply).toHaveBeenCalled();
  });

  it('refunds on error before delivery', async () => {
    const rateLimiter = mockRateLimiter();
    const agent = mockAgent({
      reply: jest.fn().mockRejectedValue(new Error('LLM failed')),
    });
    const pipeline = new ChatPipeline(
      rateLimiter,
      mockHistory(),
      agent,
      mockOutbound(),
    );

    await expect(
      pipeline.flush({
        externalUserId: 'user-1',
        texts: ['Hello'],
        idempotencyKey: 'msg-1',
      }),
    ).rejects.toThrow('LLM failed');

    expect(rateLimiter.refund).toHaveBeenCalledWith(
      'user-1',
      '2026-07-29',
      'msg-1',
    );
    expect(rateLimiter.markCompleted).not.toHaveBeenCalled();
  });

  it('does not refund when idempotencyKey is missing', async () => {
    const rateLimiter = mockRateLimiter();
    const agent = mockAgent({
      reply: jest.fn().mockRejectedValue(new Error('LLM failed')),
    });
    const pipeline = new ChatPipeline(
      rateLimiter,
      mockHistory(),
      agent,
      mockOutbound(),
    );

    await expect(
      pipeline.flush({ externalUserId: 'user-1', texts: ['Hello'] }),
    ).rejects.toThrow('LLM failed');

    expect(rateLimiter.refund).not.toHaveBeenCalled();
  });

  it('calls onBeforeSend hook before outbound', async () => {
    const onBeforeSend = jest.fn().mockResolvedValue(undefined);
    const hooks: ChatPipelineHooks = { onBeforeSend };
    const outbound = mockOutbound();
    const pipeline = new ChatPipeline(
      mockRateLimiter(),
      mockHistory(),
      mockAgent(),
      outbound,
      hooks,
    );

    await pipeline.flush({
      externalUserId: 'user-1',
      texts: ['Hello'],
      idempotencyKey: 'msg-1',
    });

    expect(onBeforeSend).toHaveBeenCalled();
    expect(onBeforeSend.mock.calls[0][0]).toMatchObject({
      externalUserId: 'user-1',
      mergedText: 'Hello',
    });
  });

  it('calls onAfterSend hook after successful delivery', async () => {
    const onAfterSend = jest.fn().mockResolvedValue(undefined);
    const hooks: ChatPipelineHooks = { onAfterSend };
    const pipeline = new ChatPipeline(
      mockRateLimiter(),
      mockHistory(),
      mockAgent(),
      mockOutbound(),
      hooks,
    );

    await pipeline.flush({
      externalUserId: 'user-1',
      texts: ['Hello'],
      idempotencyKey: 'msg-1',
    });

    expect(onAfterSend).toHaveBeenCalled();
  });

  it('does not call onAfterSend when delivery fails', async () => {
    const onAfterSend = jest.fn().mockResolvedValue(undefined);
    const outbound = mockOutbound({
      sendText: jest.fn().mockResolvedValue({ delivered: false }),
    });
    const hooks: ChatPipelineHooks = { onAfterSend };
    const pipeline = new ChatPipeline(
      mockRateLimiter(),
      mockHistory(),
      mockAgent(),
      outbound,
      hooks,
    );

    await pipeline.flush({
      externalUserId: 'user-1',
      texts: ['Hello'],
      idempotencyKey: 'msg-1',
    });

    expect(onAfterSend).not.toHaveBeenCalled();
  });

  it('calls onError hook on error before delivery', async () => {
    const onError = jest.fn().mockResolvedValue(undefined);
    const agent = mockAgent({
      reply: jest.fn().mockRejectedValue(new Error('boom')),
    });
    const hooks: ChatPipelineHooks = { onError };
    const pipeline = new ChatPipeline(
      mockRateLimiter(),
      mockHistory(),
      agent,
      mockOutbound(),
      hooks,
    );

    await expect(
      pipeline.flush({
        externalUserId: 'user-1',
        texts: ['Hello'],
        idempotencyKey: 'msg-1',
      }),
    ).rejects.toThrow('boom');

    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0][0]).toMatchObject({
      error: expect.any(Error),
    });
  });

  it('calls onStep hook at each pipeline step', async () => {
    const onStep = jest.fn().mockResolvedValue(undefined);
    const hooks: ChatPipelineHooks = { onStep };
    const pipeline = new ChatPipeline(
      mockRateLimiter(),
      mockHistory(),
      mockAgent(),
      mockOutbound(),
      hooks,
    );

    await pipeline.flush({
      externalUserId: 'user-1',
      texts: ['Hello'],
      idempotencyKey: 'msg-1',
    });

    const steps = onStep.mock.calls.map((c: unknown[]) => c[0]);
    expect(steps).toContain('before_reserve');
    expect(steps).toContain('before_history');
    expect(steps).toContain('before_agent');
    expect(steps).toContain('before_send');
    expect(steps).toContain('after_send');
  });

  it('skips send when agent reply is empty after trim', async () => {
    const rateLimiter = mockRateLimiter();
    const agent = mockAgent({
      reply: jest.fn().mockResolvedValue({ text: '  ' }),
    });
    const outbound = mockOutbound();
    const pipeline = new ChatPipeline(
      rateLimiter,
      mockHistory(),
      agent,
      outbound,
    );

    const delivered = await pipeline.flush({
      externalUserId: 'user-1',
      texts: ['Hello'],
      idempotencyKey: 'msg-1',
    });

    expect(delivered).toBe(false);
    expect(outbound.sendText).not.toHaveBeenCalled();
    // markCompleted is still called when idempotencyKey is present
    expect(rateLimiter.markCompleted).toHaveBeenCalledWith('msg-1');
  });

  it('passes userId through context', async () => {
    const agent = mockAgent();
    const outbound = mockOutbound();
    const pipeline = new ChatPipeline(
      mockRateLimiter(),
      mockHistory(),
      agent,
      outbound,
    );

    await pipeline.flush({
      externalUserId: 'user-1',
      userId: 42,
      texts: ['Hello'],
      idempotencyKey: 'msg-1',
    });

    expect(agent.reply).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 42 }),
    );
    expect(outbound.sendText).toHaveBeenCalledWith(
      'user-1',
      'Hello from agent',
      { userId: 42 },
    );
  });
});
