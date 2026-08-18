import { ConfigService } from '@nestjs/config';
import type { ChatRateLimitService } from '@messenger/modules/chat-rate-limit/application/services/chat-rate-limit.service';
import type { ChatRateLimitConfigService } from '@messenger/modules/chat-rate-limit/application/services/chat-rate-limit-config.service';
import type { ChatQuotaCheckResult } from '@messenger/modules/chat-rate-limit/domain/entities/chat-quota.types';
import type { MessengerMessageLogRepositoryPort } from '../../domain/repositories/messenger-message-log.repository.port';
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
import { MessengerChatProcessorService } from './messenger-chat-processor.service';
import type { MessengerChatSharedConfigService } from './messenger-chat-shared-config.service';
import type { MetricsService } from '@messenger/modules/metrics/metrics.service';

describe('MessengerChatProcessorService', () => {
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

    const reply = jest.fn(() =>
      Promise.resolve({ text: 'Bot reply', richFollowUps: [] as [] }),
    );
    const messengerAgentService = {
      reply,
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
    const markDelivered = jest.fn(() => Promise.resolve());
    const markCompleted = jest.fn(() => Promise.resolve());
    const refundFreeFormSlot = jest.fn(() => Promise.resolve());
    const chatRateLimitService = {
      reserveFreeFormSlot,
      markDelivered,
      markCompleted,
      refundFreeFormSlot,
    } as unknown as ChatRateLimitService;

    const chatRateLimitConfig = {
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
    } as unknown as ChatRateLimitConfigService;

    const logMessage = jest.fn(() => Promise.resolve());
    const messengerRepository = {
      logMessage,
    } as unknown as MessengerMessageLogRepositoryPort;

    const sharedConfig = {
      isDistributedQueueEnabled: () => false,
      getProcessingStuckMs: () => 600_000,
      getQueueStaleTtlMs: () => 3_600_000,
      getQueueCleanupIntervalMs: () => 900_000,
    } as unknown as MessengerChatSharedConfigService;

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

    const service = new MessengerChatProcessorService(
      configService,
      outbound,
      messengerAgentService,
      chatHistory,
      chatRateLimitService,
      chatRateLimitConfig,
      metrics,
      messengerRepository,
      sharedConfig,
    );

    return {
      service,
      sendSenderActionOptional,
      sendTextViaPsid,
      sendTextBubblesViaPsid,
      appendTurn,
      appendToolSummary,
      reply,
      reserveFreeFormSlot,
      markDelivered,
      markCompleted,
      refundFreeFormSlot,
      logMessage,
    };
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('reserves quota before LLM and marks completed on success', async () => {
    const {
      service,
      reply,
      reserveFreeFormSlot,
      sendTextBubblesViaPsid,
      markDelivered,
      markCompleted,
      appendTurn,
      refundFreeFormSlot,
      logMessage,
    } = createService();

    await service.process({
      psid: 'psid-1',
      mergedText: 'Hello',
      userId: 143,
      idempotencyKey: 'mid-1',
    });

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
    expect(markDelivered).toHaveBeenCalledWith('mid-1');
    expect(markCompleted).toHaveBeenCalledWith('mid-1');
    expect(sendTextBubblesViaPsid.mock.invocationCallOrder[0]).toBeLessThan(
      markDelivered.mock.invocationCallOrder[0],
    );
    expect(markDelivered.mock.invocationCallOrder[0]).toBeLessThan(
      appendTurn.mock.invocationCallOrder[0],
    );
    expect(appendTurn.mock.invocationCallOrder[0]).toBeLessThan(
      markCompleted.mock.invocationCallOrder[0],
    );
    expect(refundFreeFormSlot).not.toHaveBeenCalled();
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

    await service.process({
      psid: 'psid-1',
      mergedText: 'Hello',
      idempotencyKey: 'mid-1',
    });

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

    await service.process({
      psid: 'psid-1',
      mergedText: 'Hello',
      idempotencyKey: 'mid-dup',
    });

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

    await service.process({
      psid: 'psid-1',
      mergedText: 'Spam',
      idempotencyKey: 'mid-burst',
    });

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
    reply.mockImplementationOnce(() =>
      Promise.reject(new Error('OpenAI down')),
    );

    await service.process({
      psid: 'psid-1',
      mergedText: 'Hello',
      idempotencyKey: 'mid-fail',
    });

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

    await service.process({
      psid: 'psid-1',
      mergedText: 'Hello',
      idempotencyKey: 'mid-hint',
    });

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

    await service.process({
      psid: 'psid-1',
      mergedText: 'Hello',
      idempotencyKey: 'mid-zero-hint',
    });

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

    await service.process({
      psid: 'psid-1',
      mergedText: 'Hello',
      idempotencyKey: 'mid-no-hint',
    });

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

    await service.process({
      psid: 'psid-1',
      mergedText: 'Hello',
      idempotencyKey: 'mid-send-fail',
    });

    expect(refundFreeFormSlot).toHaveBeenCalledWith(
      'psid-1',
      '2026-06-15',
      'mid-send-fail',
    );
    expect(markCompleted).not.toHaveBeenCalled();
  });

  it('does not append an unseen assistant reply when Meta delivery fails', async () => {
    const { service, sendTextBubblesViaPsid, appendTurn, appendToolSummary } =
      createService();
    sendTextBubblesViaPsid.mockRejectedValue(
      new MessengerApiError('Send failed', 500, 'Error', '{}'),
    );

    await service.process({
      psid: 'psid-1',
      mergedText: 'Hello',
      idempotencyKey: 'mid-no-history-on-fail',
    });

    expect(appendTurn).not.toHaveBeenCalled();
    expect(appendToolSummary).not.toHaveBeenCalled();
  });

  it('keeps quota when at least one main bubble was delivered (H4)', async () => {
    const {
      service,
      sendTextBubblesViaPsid,
      appendTurn,
      refundFreeFormSlot,
      markCompleted,
    } = createService();
    sendTextBubblesViaPsid.mockRejectedValue(
      new MessengerPartialSendError(
        1,
        new MessengerApiError('Send failed', 500, 'Error', '{}'),
      ),
    );

    await service.process({
      psid: 'psid-1',
      mergedText: 'Hello',
      idempotencyKey: 'mid-partial',
    });

    expect(markCompleted).toHaveBeenCalledWith('mid-partial');
    expect(appendTurn).not.toHaveBeenCalled();
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

    await service.process({
      psid: 'psid-1',
      mergedText: 'Hello',
      idempotencyKey: 'mid-hint-fail',
    });

    expect(markCompleted).toHaveBeenCalledWith('mid-hint-fail');
    expect(refundFreeFormSlot).not.toHaveBeenCalled();
  });

  it('uses optional sender actions so typing_on failures do not block chat', async () => {
    const { service, reply, sendSenderActionOptional } = createService();

    await service.process({
      psid: 'psid-1',
      mergedText: 'mình muốn xem tiến độ học tập',
      idempotencyKey: 'mid-typing',
    });

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

    await service.process({
      psid: 'psid-1',
      mergedText: 'Hello',
      idempotencyKey: 'mid-window',
    });

    expect(sendTextViaPsid).toHaveBeenCalled();
    const sendArgs = (
      sendTextViaPsid.mock.calls[0] as unknown as [
        { messageType: string; text: string },
      ]
    )[0];
    expect(sendArgs.messageType).toBe('FREE_FORM_CHAT_ERROR');
    expect(sendArgs.text).toContain('24 giờ');
  });

  it('skips flush without mid when rate limit enforces (H5)', async () => {
    const { service, reply, reserveFreeFormSlot } = createService({
      shouldEnforce: true,
    });

    await service.process({
      psid: 'psid-1',
      mergedText: 'Hello',
    });

    expect(reserveFreeFormSlot).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });
});
