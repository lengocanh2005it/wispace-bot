import { ConfigService } from '@nestjs/config';
import type { ChatRateLimitService } from '@messenger/modules/chat-rate-limit/application/services/chat-rate-limit.service';
import type { ChatQuotaCheckResult } from '@messenger/modules/chat-rate-limit/domain/entities/chat-quota.types';
import type { MessengerRepositoryPort } from '../../domain/repositories/messenger.repository.port';
import type { MessengerAgentService } from '../agent/messenger-agent.service';
import {
  buildChatBurstLimitMessage,
  buildChatQuotaDeniedMessage,
  buildChatQuotaRemainingHintMessage,
} from '../messages/chat-quota.messages';
import type { ChatHistoryStorePort } from '../../domain/repositories/chat-history.store.port';
import type { MessengerOutboundService } from './messenger-outbound.service';
import {
  MessengerApiError,
  MessengerPartialSendError,
} from './messenger-outbound.service';
import { MessengerChatQueueService } from './messenger-chat-queue.service';
import type { MetricsService } from '@messenger/modules/metrics/metrics.service';

describe('MessengerChatQueueService', () => {
  let createdServices: MessengerChatQueueService[] = [];

  const quotaAllowed = (
    overrides: Partial<ChatQuotaCheckResult> = {},
  ): ChatQuotaCheckResult => ({
    allowed: true,
    used: 1,
    limit: 15,
    remaining: 14,
    usageDate: '2026-06-15',
    quotaReserved: true,
    ...overrides,
  });

  const createService = (options: { shouldEnforce?: boolean } = {}) => {
    const sendSenderActionOptional = jest.fn(() => Promise.resolve());
    const sendTextViaPsid = jest.fn(() => Promise.resolve());
    const sendTextBubblesViaPsid = jest.fn(() => Promise.resolve(1));
    const sendRichFollowUps = jest.fn(() => Promise.resolve());
    const outbound = {
      sendSenderActionOptional,
      sendTextViaPsid,
      sendTextBubblesViaPsid,
      sendRichFollowUps,
    } as unknown as MessengerOutboundService;

    const replyStream = jest.fn(
      // Returns an AsyncIterable that yields a single `done` event.
      // Tests can override with replyStream.mockImplementationOnce(...).
      () =>
        (function* () {
          yield {
            type: 'done' as const,
            reply: { text: 'Bot reply', richFollowUps: [] as [] },
          };
        })(),
    );
    // Keep `reply` alias so existing assertions still reference the same mock.
    const reply = replyStream;
    const messengerAgentService = {
      replyStream,
    } as unknown as MessengerAgentService;

    const getHistory = jest.fn(() => []);
    const appendTurn = jest.fn();
    const appendToolSummary = jest.fn();
    const chatHistory = {
      getHistory,
      appendTurn,
      appendToolSummary,
    } as unknown as ChatHistoryStorePort;

    const reserveFreeFormSlot = jest.fn(() => Promise.resolve(quotaAllowed()));
    const markCompleted = jest.fn(() => Promise.resolve());
    const refundFreeFormSlot = jest.fn(() => Promise.resolve());
    const chatRateLimitService = {
      reserveFreeFormSlot,
      markCompleted,
      refundFreeFormSlot,
      shouldEnforceForPsid: jest.fn(() => options.shouldEnforce ?? false),
      getSettings: jest.fn(() => ({
        enabled: true,
        freeFormDailyLimit: 15,
        burstPerMinute: 3,
        timezone: 'Asia/Ho_Chi_Minh',
        whitelistedPsids: [],
        remainingHintThreshold: 3,
        stuckReservedMs: 600_000,
        mergedTextMaxChars: 100,
        burstCountsRefunded: false,
      })),
    } as unknown as ChatRateLimitService;

    const logMessage = jest.fn(() => Promise.resolve());
    const messengerRepository = {
      logMessage,
    } as unknown as MessengerRepositoryPort;

    const configService = {
      get: (key: string) => {
        const values: Record<string, string> = {
          CHAT_DEBOUNCE_MS: '0',
          CHAT_MAX_BUBBLES: '4',
          CHAT_BUBBLE_MAX_CHARS: '640',
          CHAT_MERGED_TEXT_MAX_CHARS: '100',
        };
        return values[key];
      },
    } as ConfigService;

    const metrics = {
      chatStep: { startTimer: jest.fn(() => jest.fn()) },
      timeStep: jest.fn((_step: string, fn: () => Promise<unknown>) => fn()),
      timeLlmCall: jest.fn(
        (_f: string, _m: string, _r: number, fn: () => Promise<unknown>) =>
          fn(),
      ),
    } as unknown as MetricsService;

    const service = new MessengerChatQueueService(
      configService,
      outbound,
      messengerAgentService,
      chatHistory,
      chatRateLimitService,
      metrics,
      messengerRepository,
    );
    createdServices.push(service);

    return {
      service,
      sendSenderActionOptional,
      sendTextViaPsid,
      sendTextBubblesViaPsid,
      reply,
      reserveFreeFormSlot,
      markCompleted,
      refundFreeFormSlot,
      logMessage,
    };
  };

  beforeEach(() => {
    createdServices = [];
    jest.useFakeTimers();
  });

  afterEach(() => {
    for (const service of createdServices) {
      service.onModuleDestroy();
    }
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('reserves quota before LLM and marks completed on success', async () => {
    const {
      service,
      reply,
      reserveFreeFormSlot,
      markCompleted,
      refundFreeFormSlot,
      logMessage,
    } = createService();

    service.enqueue({
      psid: 'psid-1',
      userId: 143,
      userText: 'Hello',
      idempotencyKey: 'mid-1',
    });

    await jest.runOnlyPendingTimersAsync();

    expect(reserveFreeFormSlot).toHaveBeenCalledWith('psid-1', {
      userId: 143,
      idempotencyKey: 'mid-1',
    });
    expect(logMessage).toHaveBeenCalledWith({
      userId: 143,
      psid: 'psid-1',
      messageType: 'FREE_FORM_CHAT_IN',
      messageText: 'Hello',
      status: 'SENT',
    });
    expect(reply).toHaveBeenCalled();
    expect(markCompleted).toHaveBeenCalledWith('mid-1');
    expect(refundFreeFormSlot).not.toHaveBeenCalled();
  });

  it('uses the last message mid after debounce merge', async () => {
    const { service, reserveFreeFormSlot } = createService();

    service.enqueue({
      psid: 'psid-1',
      userText: 'One',
      idempotencyKey: 'mid-1',
    });
    service.enqueue({
      psid: 'psid-1',
      userText: 'Two',
      idempotencyKey: 'mid-2',
    });

    await jest.runOnlyPendingTimersAsync();

    expect(reserveFreeFormSlot).toHaveBeenCalledWith('psid-1', {
      userId: undefined,
      idempotencyKey: 'mid-2',
    });
  });

  it('sends quota denied message without calling LLM', async () => {
    const {
      service,
      sendTextViaPsid,
      reply,
      reserveFreeFormSlot,
      markCompleted,
    } = createService();
    reserveFreeFormSlot.mockResolvedValue({
      allowed: false,
      used: 15,
      limit: 15,
      remaining: 0,
      reason: 'DAILY_LIMIT',
      usageDate: '2026-06-15',
    });

    service.enqueue({
      psid: 'psid-1',
      userText: 'Hello',
      idempotencyKey: 'mid-1',
    });

    await jest.runOnlyPendingTimersAsync();

    expect(sendTextViaPsid).toHaveBeenCalledWith({
      psid: 'psid-1',
      userId: undefined,
      text: buildChatQuotaDeniedMessage(15),
      messageType: 'CHAT_QUOTA_DENIED',
    });
    expect(reply).not.toHaveBeenCalled();
    expect(markCompleted).not.toHaveBeenCalled();
  });

  it('skips LLM on idempotency conflict', async () => {
    const { service, reply, reserveFreeFormSlot, markCompleted } =
      createService();
    reserveFreeFormSlot.mockResolvedValue({
      allowed: false,
      used: 3,
      limit: 15,
      remaining: 12,
      reason: 'IDEMPOTENCY_CONFLICT',
      usageDate: '2026-06-15',
    });

    service.enqueue({
      psid: 'psid-1',
      userText: 'Hello',
      idempotencyKey: 'mid-dup',
    });

    await jest.runOnlyPendingTimersAsync();

    expect(reply).not.toHaveBeenCalled();
    expect(markCompleted).not.toHaveBeenCalled();
  });

  it('sends burst limit message without calling LLM', async () => {
    const { service, sendTextViaPsid, reply, reserveFreeFormSlot } =
      createService();
    reserveFreeFormSlot.mockResolvedValue({
      allowed: false,
      used: 3,
      limit: 3,
      remaining: 0,
      reason: 'BURST_LIMIT',
      usageDate: '2026-06-15',
      quotaReserved: false,
    });

    service.enqueue({
      psid: 'psid-1',
      userText: 'Spam',
      idempotencyKey: 'mid-burst',
    });

    await jest.runOnlyPendingTimersAsync();

    expect(sendTextViaPsid).toHaveBeenCalledWith({
      psid: 'psid-1',
      userId: undefined,
      text: buildChatBurstLimitMessage(3),
      messageType: 'CHAT_QUOTA_DENIED',
    });
    expect(reply).not.toHaveBeenCalled();
  });

  it('refunds quota when LLM fails', async () => {
    const {
      service,
      sendTextViaPsid,
      reply,
      refundFreeFormSlot,
      markCompleted,
    } = createService();
    reply.mockImplementationOnce(() => {
      const err = new Error('OpenAI down');
      // Return an object satisfying AsyncIterable that throws on first next()
      return {
        [Symbol.asyncIterator]() {
          return { next: () => Promise.reject(err) };
        },
      };
    });

    service.enqueue({
      psid: 'psid-1',
      userText: 'Hello',
      idempotencyKey: 'mid-fail',
    });

    await jest.runOnlyPendingTimersAsync();

    expect(refundFreeFormSlot).toHaveBeenCalledWith(
      'psid-1',
      '2026-06-15',
      'mid-fail',
    );
    expect(sendTextViaPsid).toHaveBeenCalledWith(
      expect.objectContaining({
        messageType: 'FREE_FORM_CHAT_ERROR',
      }),
    );
    expect(markCompleted).not.toHaveBeenCalled();
  });

  it('sends remaining quota hint when remaining is at or below threshold', async () => {
    const { service, sendTextViaPsid, reserveFreeFormSlot } = createService();
    reserveFreeFormSlot.mockResolvedValue(
      quotaAllowed({ used: 13, remaining: 2 }),
    );

    service.enqueue({
      psid: 'psid-1',
      userText: 'Hello',
      idempotencyKey: 'mid-hint',
    });

    await jest.runOnlyPendingTimersAsync();

    expect(sendTextViaPsid).toHaveBeenCalledWith({
      psid: 'psid-1',
      userId: undefined,
      text: buildChatQuotaRemainingHintMessage(2),
      messageType: 'CHAT_QUOTA_REMAINING_HINT',
    });
  });

  it('does not send remaining quota hint when remaining is zero', async () => {
    const { service, sendTextViaPsid, reserveFreeFormSlot } = createService();
    reserveFreeFormSlot.mockResolvedValue(
      quotaAllowed({ used: 15, remaining: 0 }),
    );

    service.enqueue({
      psid: 'psid-1',
      userText: 'Hello',
      idempotencyKey: 'mid-zero-hint',
    });

    await jest.runOnlyPendingTimersAsync();

    expect(sendTextViaPsid).not.toHaveBeenCalledWith(
      expect.objectContaining({
        messageType: 'CHAT_QUOTA_REMAINING_HINT',
      }),
    );
  });

  it('does not send remaining quota hint when remaining is above threshold', async () => {
    const { service, sendTextViaPsid, reserveFreeFormSlot } = createService();
    reserveFreeFormSlot.mockResolvedValue(
      quotaAllowed({ used: 5, remaining: 10 }),
    );

    service.enqueue({
      psid: 'psid-1',
      userText: 'Hello',
      idempotencyKey: 'mid-no-hint',
    });

    await jest.runOnlyPendingTimersAsync();

    expect(sendTextViaPsid).not.toHaveBeenCalledWith(
      expect.objectContaining({
        messageType: 'CHAT_QUOTA_REMAINING_HINT',
      }),
    );
  });

  it('refunds quota when Send API fails before any main bubble (H4)', async () => {
    const {
      service,
      sendTextBubblesViaPsid,
      refundFreeFormSlot,
      markCompleted,
    } = createService();
    sendTextBubblesViaPsid.mockRejectedValue(
      new MessengerApiError('Send failed', 500, 'Error', '{}'),
    );

    service.enqueue({
      psid: 'psid-1',
      userText: 'Hello',
      idempotencyKey: 'mid-send-fail',
    });

    await jest.runOnlyPendingTimersAsync();

    expect(refundFreeFormSlot).toHaveBeenCalledWith(
      'psid-1',
      '2026-06-15',
      'mid-send-fail',
    );
    expect(markCompleted).not.toHaveBeenCalled();
  });

  it('keeps quota when at least one main bubble was delivered (H4)', async () => {
    const {
      service,
      sendTextBubblesViaPsid,
      refundFreeFormSlot,
      markCompleted,
    } = createService();
    sendTextBubblesViaPsid.mockRejectedValue(
      new MessengerPartialSendError(
        1,
        new MessengerApiError('Send failed', 500, 'Error', '{}'),
      ),
    );

    service.enqueue({
      psid: 'psid-1',
      userText: 'Hello',
      idempotencyKey: 'mid-partial',
    });

    await jest.runOnlyPendingTimersAsync();

    expect(markCompleted).toHaveBeenCalledWith('mid-partial');
    expect(refundFreeFormSlot).not.toHaveBeenCalled();
  });

  it('does not refund when quota hint fails after main reply (H4)', async () => {
    const { service, sendTextViaPsid, refundFreeFormSlot, markCompleted } =
      createService();
    (sendTextViaPsid as jest.Mock).mockImplementation(
      (params: { messageType: string }) => {
        if (params.messageType === 'CHAT_QUOTA_REMAINING_HINT') {
          return Promise.reject(new Error('hint send failed'));
        }

        return Promise.resolve();
      },
    );

    service.enqueue({
      psid: 'psid-1',
      userText: 'Hello',
      idempotencyKey: 'mid-hint-fail',
    });

    await jest.runOnlyPendingTimersAsync();

    expect(markCompleted).toHaveBeenCalledWith('mid-hint-fail');
    expect(refundFreeFormSlot).not.toHaveBeenCalled();
  });

  it('uses optional sender actions so typing_on failures do not block chat', async () => {
    const { service, reply, sendSenderActionOptional } = createService();

    service.enqueue({
      psid: 'psid-1',
      userText: 'mình muốn xem tiến độ học tập',
      idempotencyKey: 'mid-typing',
    });

    await jest.runOnlyPendingTimersAsync();

    expect(sendSenderActionOptional).toHaveBeenCalledWith(
      'psid-1',
      'mark_seen',
    );
    expect(sendSenderActionOptional).toHaveBeenCalledWith(
      'psid-1',
      'typing_on',
    );
    expect(reply).toHaveBeenCalled();
  });

  it('sends 24h window guidance when Send API rejects outside window (H4)', async () => {
    const { service, sendTextBubblesViaPsid, sendTextViaPsid } =
      createService();
    sendTextBubblesViaPsid.mockRejectedValue(
      new MessengerApiError(
        'Send failed',
        400,
        'Bad Request',
        '{"error":{"code":10,"message":"Outside the allowed window"}}',
      ),
    );

    service.enqueue({
      psid: 'psid-1',
      userText: 'Hello',
      idempotencyKey: 'mid-window',
    });

    await jest.runOnlyPendingTimersAsync();

    expect(sendTextViaPsid).toHaveBeenCalled();
    const sendArgs = (
      sendTextViaPsid.mock.calls[0] as unknown as [
        { messageType: string; text: string },
      ]
    )[0];
    expect(sendArgs.messageType).toBe('FREE_FORM_CHAT_ERROR');
    expect(sendArgs.text).toContain('24 giờ');
  });

  it('caps merged debounce text before LLM (H5)', async () => {
    const { service, reply } = createService();

    service.enqueue({
      psid: 'psid-1',
      userText: 'a'.repeat(80),
      idempotencyKey: 'mid-1',
    });
    service.enqueue({
      psid: 'psid-1',
      userText: 'b'.repeat(80),
      idempotencyKey: 'mid-2',
    });

    await jest.runOnlyPendingTimersAsync();

    const userText = (
      reply.mock.calls[0] as unknown as [{ userText: string }]
    )[0].userText;
    expect(userText.length).toBeLessThanOrEqual(100);
    expect(userText).toContain('…');
  });

  it('skips flush without mid when rate limit enforces (H5)', async () => {
    const { service, reply, reserveFreeFormSlot } = createService({
      shouldEnforce: true,
    });

    service.enqueue({
      psid: 'psid-1',
      userText: 'Hello',
    });

    await jest.runOnlyPendingTimersAsync();

    expect(reserveFreeFormSlot).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });
});
