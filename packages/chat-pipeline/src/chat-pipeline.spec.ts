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
    markDelivered: jest.fn().mockResolvedValue(undefined),
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
  it('calls reserve → history → agent → send → markDelivered → append → markCompleted', async () => {
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
      undefined,
    );
    expect(outbound.sendText).toHaveBeenCalledWith(
      'user-1',
      'Hello from agent',
      { userId: undefined },
    );
    expect(rateLimiter.markCompleted).toHaveBeenCalledWith('msg-1');
    expect(rateLimiter.markDelivered).toHaveBeenCalledWith('msg-1');
  });

  it('does not persist bounded clarification noise as long-term history', async () => {
    const history = mockHistory();
    const pipeline = new ChatPipeline(
      mockRateLimiter(),
      history,
      mockAgent({
        reply: jest.fn().mockResolvedValue({
          text: 'Bạn chọn 1, 2 hoặc 3 nhé.',
          skipHistory: true,
        }),
      }),
      mockOutbound(),
    );

    await expect(
      pipeline.flush({
        externalUserId: 'user-1',
        texts: ['???'],
        idempotencyKey: 'clarification-1',
      }),
    ).resolves.toBe(true);

    expect(history.appendTurn).not.toHaveBeenCalled();
  });

  it('forwards clarification delivery identity to outbound providers', async () => {
    const outbound = mockOutbound();
    const pipeline = new ChatPipeline(
      mockRateLimiter(),
      mockHistory(),
      mockAgent({
        reply: jest.fn().mockResolvedValue({
          text: 'Bạn chọn 1, 2 hoặc 3 nhé.',
          skipHistory: true,
          clarification: true,
          deliveryKey: 'clarification:event-1',
        }),
      }),
      outbound,
    );

    await pipeline.flush({
      externalUserId: 'user-1',
      texts: ['???'],
      idempotencyKey: 'event-1',
    });

    expect(outbound.sendText).toHaveBeenCalledWith(
      'user-1',
      'Bạn chọn 1, 2 hoặc 3 nhé.',
      {
        userId: undefined,
        deliveryKey: 'clarification:event-1',
        clarification: true,
      },
    );
  });

  it('suppresses a replay after a clarification reply was already attempted', async () => {
    const outbound = mockOutbound();
    const rateLimiter = mockRateLimiter();
    const history = mockHistory();
    const pipeline = new ChatPipeline(
      rateLimiter,
      history,
      mockAgent({
        reply: jest.fn().mockResolvedValue({
          text: 'Bạn chọn 1, 2 hoặc 3 nhé.',
          skipHistory: true,
          clarification: true,
          skipDelivery: true,
        }),
      }),
      outbound,
    );

    await expect(
      pipeline.flush({
        externalUserId: 'user-1',
        texts: ['???'],
        idempotencyKey: 'event-1',
      }),
    ).resolves.toBe(true);

    expect(outbound.sendText).not.toHaveBeenCalled();
    expect(history.appendTurn).not.toHaveBeenCalled();
    expect(rateLimiter.markDelivered).toHaveBeenCalledWith('event-1');
    expect(rateLimiter.markCompleted).toHaveBeenCalledWith('event-1');
  });

  it('marks ambiguous clarification delivery so retry logic cannot resend blindly', async () => {
    const onError = jest.fn().mockResolvedValue(undefined);
    const pipeline = new ChatPipeline(
      mockRateLimiter(),
      mockHistory(),
      mockAgent({
        reply: jest.fn().mockResolvedValue({
          text: 'Bạn chọn 1, 2 hoặc 3 nhé.',
          skipHistory: true,
          clarification: true,
        }),
      }),
      mockOutbound({
        sendText: jest.fn().mockRejectedValue(new Error('provider timeout')),
        isAmbiguousDeliveryError: jest.fn().mockReturnValue(true),
      }),
      { onError },
    );

    await expect(
      pipeline.flush({
        externalUserId: 'user-1',
        texts: ['???'],
        idempotencyKey: 'event-ambiguous',
      }),
    ).rejects.toThrow('provider timeout');

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryAmbiguous: true }),
    );
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

  it('calls onError for an outbound failure before delivery', async () => {
    const onError = jest.fn().mockResolvedValue(undefined);
    const outboundError = new Error('outbound failed');
    const outbound = mockOutbound({
      sendText: jest.fn().mockRejectedValue(outboundError),
    });
    const pipeline = new ChatPipeline(
      mockRateLimiter(),
      mockHistory(),
      mockAgent(),
      outbound,
      { onError },
    );

    await expect(
      pipeline.flush({
        externalUserId: 'user-1',
        texts: ['Hello'],
        idempotencyKey: 'msg-1',
      }),
    ).rejects.toThrow('outbound failed');

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ error: outboundError }),
    );
  });

  it('keeps a delivered quota slot for recovery when completion fails', async () => {
    const onError = jest.fn().mockResolvedValue(undefined);
    const markDelivered = jest.fn().mockResolvedValue(undefined);
    const markCompleted = jest
      .fn()
      .mockRejectedValue(new Error('quota database unavailable'));
    const rateLimiter = mockRateLimiter({ markDelivered, markCompleted });
    const history = mockHistory();
    const pipeline = new ChatPipeline(
      rateLimiter,
      history,
      mockAgent(),
      mockOutbound(),
      { onError },
    );

    await expect(
      pipeline.flush({
        externalUserId: 'user-1',
        texts: ['Hello'],
        idempotencyKey: 'msg-delivered',
      }),
    ).resolves.toBe(true);

    expect(rateLimiter.refund).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(history.appendTurn).toHaveBeenCalled();
    expect(markDelivered.mock.invocationCallOrder[0]).toBeLessThan(
      markCompleted.mock.invocationCallOrder[0],
    );
  });

  it('calls onError when outbound delivery is explicitly unconfirmed', async () => {
    const onError = jest.fn().mockResolvedValue(undefined);
    const rateLimiter = mockRateLimiter();
    const pipeline = new ChatPipeline(
      rateLimiter,
      mockHistory(),
      mockAgent(),
      mockOutbound({
        sendText: jest.fn().mockResolvedValue({ delivered: false }),
      }),
      { onError },
    );

    await expect(
      pipeline.flush({
        externalUserId: 'user-1',
        texts: ['Hello'],
        idempotencyKey: 'msg-1',
      }),
    ).resolves.toBe(false);

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
    );
    expect(rateLimiter.refund).toHaveBeenCalledWith(
      'user-1',
      '2026-07-29',
      'msg-1',
    );
    expect(rateLimiter.markDelivered).not.toHaveBeenCalled();
  });

  it('calls onError and refunds when history loading fails', async () => {
    const onError = jest.fn().mockResolvedValue(undefined);
    const historyError = new Error('history unavailable');
    const rateLimiter = mockRateLimiter();
    const pipeline = new ChatPipeline(
      rateLimiter,
      mockHistory({
        getHistory: jest.fn().mockRejectedValue(historyError),
      }),
      mockAgent(),
      mockOutbound(),
      { onError },
    );

    await expect(
      pipeline.flush({
        externalUserId: 'user-1',
        texts: ['Hello'],
        idempotencyKey: 'msg-1',
      }),
    ).rejects.toThrow('history unavailable');

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ error: historyError }),
    );
    expect(rateLimiter.refund).toHaveBeenCalledWith(
      'user-1',
      '2026-07-29',
      'msg-1',
    );
  });

  it('still calls onError when the quota refund itself fails', async () => {
    const onError = jest.fn().mockResolvedValue(undefined);
    const originalError = new Error('history unavailable');
    const refundError = new Error('refund unavailable');
    const rateLimiter = mockRateLimiter({
      refund: jest.fn().mockRejectedValue(refundError),
    });
    const pipeline = new ChatPipeline(
      rateLimiter,
      mockHistory({
        getHistory: jest.fn().mockRejectedValue(originalError),
      }),
      mockAgent(),
      mockOutbound(),
      { onError },
    );

    await expect(
      pipeline.flush({
        externalUserId: 'user-1',
        texts: ['Hello'],
        idempotencyKey: 'msg-1',
      }),
    ).rejects.toThrow('history unavailable');

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        error: originalError,
        refundError,
      }),
    );
    expect(rateLimiter.refund).toHaveBeenCalledTimes(1);
  });

  it('treats an agent tool failure like any other pre-delivery failure', async () => {
    const onError = jest.fn().mockResolvedValue(undefined);
    const toolError = new Error('tool failed');
    const rateLimiter = mockRateLimiter();
    const pipeline = new ChatPipeline(
      rateLimiter,
      mockHistory(),
      mockAgent({ reply: jest.fn().mockRejectedValue(toolError) }),
      mockOutbound(),
      { onError },
    );

    await expect(
      pipeline.flush({
        externalUserId: 'user-1',
        texts: ['Check my schedule'],
        idempotencyKey: 'msg-1',
      }),
    ).rejects.toThrow('tool failed');

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ error: toolError }),
    );
    expect(rateLimiter.refund).toHaveBeenCalled();
  });

  it('does not call onError or refund after the main reply was delivered', async () => {
    const onError = jest.fn().mockResolvedValue(undefined);
    const appendError = new Error('history append failed');
    const rateLimiter = mockRateLimiter();
    const history = mockHistory({
      appendTurn: jest.fn().mockRejectedValue(appendError),
    });
    const pipeline = new ChatPipeline(
      rateLimiter,
      history,
      mockAgent(),
      mockOutbound(),
      { onError },
    );

    await expect(
      pipeline.flush({
        externalUserId: 'user-1',
        texts: ['Hello'],
        idempotencyKey: 'msg-1',
      }),
    ).rejects.toThrow('history append failed');

    expect(onError).not.toHaveBeenCalled();
    expect(rateLimiter.refund).not.toHaveBeenCalled();
    expect(rateLimiter.markDelivered).toHaveBeenCalledWith('msg-1');
    expect(rateLimiter.markCompleted).not.toHaveBeenCalled();
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
    expect(rateLimiter.markCompleted).not.toHaveBeenCalled();
    expect(rateLimiter.refund).toHaveBeenCalledWith(
      'user-1',
      '2026-07-29',
      'msg-1',
    );
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

  it('passes toolSummary to history.appendTurn', async () => {
    const history = mockHistory();
    const agent = mockAgent({
      reply: jest.fn().mockResolvedValue({
        text: 'Hello from agent',
        toolSummary: 'Checked schedule',
      }),
    });
    const pipeline = new ChatPipeline(
      mockRateLimiter(),
      history,
      agent,
      mockOutbound(),
    );

    await pipeline.flush({
      externalUserId: 'user-1',
      texts: ['Hello'],
      idempotencyKey: 'msg-1',
    });

    expect(history.appendTurn).toHaveBeenCalledWith(
      'user-1',
      'Hello',
      'Hello from agent',
      'Checked schedule',
    );
  });

  it('does not refund on partial delivery', async () => {
    const rateLimiter = mockRateLimiter();
    const outbound = mockOutbound({
      sendText: jest.fn().mockResolvedValue({ delivered: true, partial: true }),
    });
    const pipeline = new ChatPipeline(
      rateLimiter,
      mockHistory(),
      mockAgent(),
      outbound,
    );

    const delivered = await pipeline.flush({
      externalUserId: 'user-1',
      texts: ['Hello'],
      idempotencyKey: 'msg-1',
    });

    expect(delivered).toBe(true);
    expect(rateLimiter.refund).not.toHaveBeenCalled();
    expect(rateLimiter.markDelivered).toHaveBeenCalledWith('msg-1');
    expect(rateLimiter.markCompleted).toHaveBeenCalledWith('msg-1');
  });

  it('sets partialDelivery in context for onAfterSend hook', async () => {
    const onAfterSend = jest.fn().mockResolvedValue(undefined);
    const outbound = mockOutbound({
      sendText: jest.fn().mockResolvedValue({ delivered: true, partial: true }),
    });
    const pipeline = new ChatPipeline(
      mockRateLimiter(),
      mockHistory(),
      mockAgent(),
      outbound,
      { onAfterSend },
    );

    await pipeline.flush({
      externalUserId: 'user-1',
      texts: ['Hello'],
      idempotencyKey: 'msg-1',
    });

    expect(onAfterSend).toHaveBeenCalled();
    expect(onAfterSend.mock.calls[0][0]).toMatchObject({
      partialDelivery: true,
    });
  });
});
