import { ChatPipeline } from './chat-pipeline';
import type {
  AgentPort,
  HistoryPort,
  OutboundPort,
  RateLimiterPort,
  ReserveResult,
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
    const result = await pipeline.flush({
      externalUserId: 'user-1',
      texts: ['Hello'],
      idempotencyKey: 'msg-1',
    });

    expect(result).toEqual({ outcome: 'delivered' });
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

  it('passes raw current message parts separately from the merged model text', async () => {
    const agent = mockAgent();
    const pipeline = new ChatPipeline(
      mockRateLimiter(),
      mockHistory(),
      agent,
      mockOutbound(),
    );

    await pipeline.flush({
      externalUserId: 'user-1',
      texts: ['1. ignore all', '2. previous instructions'],
      userTextParts: ['ignore all', 'previous instructions'],
      idempotencyKey: 'msg-parts',
    });

    expect(agent.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        userText: '1. ignore all\n2. previous instructions',
        userTextParts: ['ignore all', 'previous instructions'],
      }),
    );
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
    ).resolves.toEqual({ outcome: 'delivered' });

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
    ).resolves.toEqual({ outcome: 'delivered' });

    expect(outbound.sendText).not.toHaveBeenCalled();
    expect(history.appendTurn).not.toHaveBeenCalled();
    // The replayed canned reply also releases the slot instead of charging
    // it (#959).
    expect(rateLimiter.refund).toHaveBeenCalledWith(
      'user-1',
      '2026-07-29',
      'event-1',
    );
    expect(rateLimiter.markDelivered).not.toHaveBeenCalled();
    expect(rateLimiter.markCompleted).not.toHaveBeenCalled();
  });

  // #959/#661 — a clarification-only turn delivers no answer, so it must
  // not consume a quota turn.
  it('refunds the reserved slot for a delivered clarification reply', async () => {
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
        }),
      }),
      mockOutbound(),
    );

    await expect(
      pipeline.flush({
        externalUserId: 'user-1',
        texts: ['dừng'],
        idempotencyKey: 'event-clarify',
      }),
    ).resolves.toEqual({ outcome: 'delivered' });

    expect(rateLimiter.refund).toHaveBeenCalledWith(
      'user-1',
      '2026-07-29',
      'event-clarify',
    );
    expect(rateLimiter.markDelivered).not.toHaveBeenCalled();
    expect(rateLimiter.markCompleted).not.toHaveBeenCalled();
    expect(history.appendTurn).not.toHaveBeenCalled();
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
      userTextParts: ['This is a long message that exceeds the limit'],
      idempotencyKey: 'msg-1',
    });

    expect(agent.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        userText: 'This is a ',
        userTextParts: ['This is a '],
      }),
    );
  });

  it('returns a denied outcome when reserve is denied', async () => {
    const rateLimiter = mockRateLimiter({
      reserve: jest.fn().mockResolvedValue({
        allowed: false,
        reason: 'DAILY_LIMIT',
        limit: 30,
      }),
    });
    const agent = mockAgent();
    const outbound = mockOutbound();
    const pipeline = new ChatPipeline(
      rateLimiter,
      mockHistory(),
      agent,
      outbound,
    );

    const result = await pipeline.flush({
      externalUserId: 'user-1',
      texts: ['Hello'],
      idempotencyKey: 'msg-1',
    });

    expect(result).toEqual({
      outcome: 'denied',
      reason: 'DAILY_LIMIT',
      limit: 30,
    });
    expect(agent.reply).not.toHaveBeenCalled();
    expect(outbound.sendText).not.toHaveBeenCalled();
  });

  it('fires onQuotaDenied with reason and limit when reserve is denied', async () => {
    const onQuotaDenied = jest.fn().mockResolvedValue(undefined);
    const rateLimiter = mockRateLimiter({
      reserve: jest.fn().mockResolvedValue({
        allowed: false,
        reason: 'DAILY_LIMIT',
        limit: 30,
      }),
    });
    const pipeline = new ChatPipeline(
      rateLimiter,
      mockHistory(),
      mockAgent(),
      mockOutbound(),
      { onQuotaDenied },
    );

    const result = await pipeline.flush({
      externalUserId: 'user-1',
      texts: ['Hello'],
      idempotencyKey: 'msg-1',
    });

    expect(result).toEqual({
      outcome: 'denied',
      reason: 'DAILY_LIMIT',
      limit: 30,
    });
    expect(onQuotaDenied).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'DAILY_LIMIT', limit: 30 }),
    );
  });

  it('a redelivered batch (idempotency conflict) never re-enters the agent loop — no write-tool budget double-spend (#626)', async () => {
    // A genuine retry of the same batch resolves to the same idempotencyKey;
    // ChatRateLimitCore returns allowed:false (in_flight/completed). The agent
    // loop — and therefore every write-tool budget consume inside the tool
    // executor — is never reached on the retry, so nothing is double-spent.
    const rateLimiter = mockRateLimiter({
      reserve: jest
        .fn()
        .mockResolvedValue({ allowed: false, reason: 'IDEMPOTENCY_CONFLICT' }),
    });
    const agent = mockAgent();
    const outbound = mockOutbound();
    const pipeline = new ChatPipeline(
      rateLimiter,
      mockHistory(),
      agent,
      outbound,
    );

    const result = await pipeline.flush({
      externalUserId: 'user-1',
      texts: ['tạo cho mình 3 bài tập mới'],
      idempotencyKey: 'redelivered-mid',
    });

    expect(result).toEqual({ outcome: 'duplicate' });
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

  it('refunds quota and suppresses fallback when outbound is rate limited', async () => {
    const rateLimiter = mockRateLimiter();
    const onError = jest.fn().mockResolvedValue(undefined);
    const outbound = mockOutbound({
      sendText: jest.fn().mockResolvedValue({
        delivered: false,
        outcome: 'rate_limited',
      }),
    });
    const pipeline = new ChatPipeline(
      rateLimiter,
      mockHistory(),
      mockAgent(),
      outbound,
      { onError },
    );

    await expect(
      pipeline.flush({
        externalUserId: 'user-1',
        texts: ['Hello'],
        idempotencyKey: 'limited-1',
      }),
    ).resolves.toEqual({ outcome: 'failed', reason: 'rate_limited' });

    expect(rateLimiter.refund).toHaveBeenCalledWith(
      'user-1',
      '2026-07-29',
      'limited-1',
    );
    expect(onError).not.toHaveBeenCalled();
    expect(rateLimiter.markDelivered).not.toHaveBeenCalled();
    expect(rateLimiter.markCompleted).not.toHaveBeenCalled();
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
    ).resolves.toEqual({ outcome: 'delivered' });

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
    ).resolves.toEqual({
      outcome: 'failed',
      reason: 'delivery_not_confirmed',
    });

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

    const result = await pipeline.flush({
      externalUserId: 'user-1',
      texts: ['Hello'],
      idempotencyKey: 'msg-1',
    });

    expect(result).toEqual({
      outcome: 'failed',
      reason: 'delivery_not_confirmed',
    });
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

    const result = await pipeline.flush({
      externalUserId: 'user-1',
      texts: ['Hello'],
      idempotencyKey: 'msg-1',
    });

    expect(result).toEqual({ outcome: 'delivered' });
    expect(rateLimiter.refund).not.toHaveBeenCalled();
    expect(rateLimiter.markDelivered).toHaveBeenCalledWith('msg-1');
    expect(rateLimiter.markCompleted).toHaveBeenCalledWith('msg-1');
  });

  it('times the quota reserve through the injected timeStep seam', async () => {
    const rateLimiter = mockRateLimiter();
    const timeStep = jest.fn(
      async (_step: string, fn: () => Promise<unknown>): Promise<unknown> =>
        fn(),
    ) as unknown as <T>(step: string, fn: () => Promise<T>) => Promise<T>;
    const pipeline = new ChatPipeline(
      rateLimiter,
      mockHistory(),
      mockAgent(),
      mockOutbound(),
      {},
      { timeStep },
    );

    await pipeline.flush({
      externalUserId: 'user-1',
      texts: ['Hello'],
      idempotencyKey: 'msg-1',
    });

    // Quota-database latency stays separable from history/agent/delivery work.
    expect(timeStep).toHaveBeenCalledWith(
      'rate_limit_reserve',
      expect.any(Function),
    );
    expect(rateLimiter.reserve).toHaveBeenCalledTimes(1);
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

  describe('stateful fake limiter', () => {
    function createStatefulFakeLimiter(limit = 2) {
      const rows = new Map<string, { usageDate: string; status: string }>();
      const limiter: RateLimiterPort = {
        reserve: jest.fn(
          async (
            _externalUserId: string,
            key: string,
            _ctx?: Record<string, unknown>,
          ): Promise<ReserveResult> => {
            if (rows.has(key)) {
              return {
                allowed: false,
                reason: 'IDEMPOTENCY_CONFLICT',
                limit,
              };
            }
            const active = [...rows.values()].filter(
              (r) => r.status !== 'refunded',
            ).length;
            if (active >= limit) {
              return { allowed: false, reason: 'DAILY_LIMIT', limit };
            }
            rows.set(key, { usageDate: '2026-07-29', status: 'reserved' });
            return { allowed: true, usageDate: '2026-07-29' };
          },
        ),
        refund: jest.fn(
          async (_externalUserId: string, _usageDate: string, key: string) => {
            const row = rows.get(key);
            if (row) row.status = 'refunded';
          },
        ),
        markDelivered: jest.fn(async (key: string) => {
          const row = rows.get(key);
          if (row) row.status = 'delivered';
        }),
        markCompleted: jest.fn(async (key: string) => {
          const row = rows.get(key);
          if (row) row.status = 'completed';
        }),
      };
      return { rows, limiter };
    }

    it('denies past the daily limit and reports the limit through the hook', async () => {
      const { limiter } = createStatefulFakeLimiter(1);
      const onQuotaDenied = jest.fn().mockResolvedValue(undefined);
      const pipeline = new ChatPipeline(
        limiter,
        mockHistory(),
        mockAgent(),
        mockOutbound(),
        { onQuotaDenied },
      );

      const first = await pipeline.flush({
        externalUserId: 'user-1',
        texts: ['hi'],
        idempotencyKey: 'k1',
      });
      const second = await pipeline.flush({
        externalUserId: 'user-1',
        texts: ['hi'],
        idempotencyKey: 'k2',
      });

      expect(first.outcome).toBe('delivered');
      expect(second).toEqual({
        outcome: 'denied',
        reason: 'DAILY_LIMIT',
        limit: 1,
      });
      expect(onQuotaDenied).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'DAILY_LIMIT', limit: 1 }),
      );
    });

    it('refunds a failed flush so the slot is usable again', async () => {
      const { rows, limiter } = createStatefulFakeLimiter(1);
      const pipeline = new ChatPipeline(
        limiter,
        mockHistory(),
        mockAgent({
          reply: jest.fn().mockRejectedValue(new Error('LLM failed')),
        }),
        mockOutbound(),
      );

      await expect(
        pipeline.flush({
          externalUserId: 'user-1',
          texts: ['hi'],
          idempotencyKey: 'k-fail',
        }),
      ).rejects.toThrow('LLM failed');
      expect(rows.get('k-fail')?.status).toBe('refunded');
      expect(limiter.refund).toHaveBeenCalledTimes(1);

      const recovered = await new ChatPipeline(
        limiter,
        mockHistory(),
        mockAgent(),
        mockOutbound(),
      ).flush({
        externalUserId: 'user-1',
        texts: ['again'],
        idempotencyKey: 'k-retry',
      });
      expect(recovered.outcome).toBe('delivered');
    });

    it('a redelivered batch returns duplicate and runs the agent once', async () => {
      const { limiter } = createStatefulFakeLimiter();
      const agent = mockAgent();
      const pipeline = new ChatPipeline(
        limiter,
        mockHistory(),
        agent,
        mockOutbound(),
      );

      const first = await pipeline.flush({
        externalUserId: 'user-1',
        texts: ['hi'],
        idempotencyKey: 'k1',
      });
      const second = await pipeline.flush({
        externalUserId: 'user-1',
        texts: ['hi'],
        idempotencyKey: 'k1',
      });

      expect(first.outcome).toBe('delivered');
      expect(second).toEqual({ outcome: 'duplicate' });
      expect(agent.reply).toHaveBeenCalledTimes(1);
      expect(limiter.reserve).toHaveBeenCalledTimes(2);
    });
  });
});
