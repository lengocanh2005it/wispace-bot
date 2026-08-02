import type { ConfigService } from '@nestjs/config';
import { ZaloChatService } from './zalo-chat.service';
import { ZaloOutboundService } from './zalo-outbound.service';
import { ZaloAccountLinkService } from '@zalo/modules/zalo-oauth/application/services/zalo-account-link.service';
import { ZaloChatQueueService } from './zalo-chat-queue.service';
import type { ZaloRescheduleConfirmationService } from './zalo-reschedule-confirmation.service';

const NO_RESCHEDULE = {
  hasPending: jest.fn().mockResolvedValue(false),
} as unknown as ZaloRescheduleConfirmationService;

function buildConfig(): ConfigService {
  return {
    get: (key: string) =>
      ({
        ZALO_APP_ID: 'app-1',
        ZALO_OAUTH_REDIRECT_URI:
          'https://zalo-bot.example.com/zalo/oauth/callback',
      })[key],
  } as unknown as ConfigService;
}

describe('ZaloChatService', () => {
  it('enqueues message and resolves userId', async () => {
    const findUserIdByZaloId = jest.fn().mockResolvedValue(42);
    const enqueue = jest.fn();

    const service = new ZaloChatService(
      buildConfig(),
      {} as unknown as ZaloOutboundService,
      { findUserIdByZaloId } as unknown as ZaloAccountLinkService,
      { enqueue } as unknown as ZaloChatQueueService,
      NO_RESCHEDULE,
    );

    await service.handleIncomingMessage('zalo-1', 'xem lich hoc cua minh');

    expect(findUserIdByZaloId).toHaveBeenCalledWith('zalo-1');
    expect(enqueue).toHaveBeenCalledWith(
      'zalo-1',
      'xem lich hoc cua minh',
      { userId: 42 },
      expect.any(String),
    );
  });

  it('replies directly to greeting without enqueueing', async () => {
    const sendText = jest.fn().mockResolvedValue(undefined);
    const enqueue = jest.fn();

    const service = new ZaloChatService(
      buildConfig(),
      { sendText } as unknown as ZaloOutboundService,
      {} as unknown as ZaloAccountLinkService,
      { enqueue } as unknown as ZaloChatQueueService,
      NO_RESCHEDULE,
    );

    await service.handleIncomingMessage('zalo-1', 'chào bạn');

    expect(sendText).toHaveBeenCalledWith(
      'zalo-1',
      expect.stringContaining('WISPACE'),
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('sends a welcome message on follow', async () => {
    const sendText = jest.fn().mockResolvedValue(undefined);
    const service = new ZaloChatService(
      buildConfig(),
      { sendText } as unknown as ZaloOutboundService,
      {} as unknown as ZaloAccountLinkService,
      {} as unknown as ZaloChatQueueService,
      NO_RESCHEDULE,
    );

    await service.handleFollow('zalo-1');

    expect(sendText).toHaveBeenCalledWith(
      'zalo-1',
      expect.stringContaining('WISPACE'),
    );
  });

  it('sends a text-only fallback message for unsupported message types', async () => {
    const sendText = jest.fn().mockResolvedValue(undefined);
    const service = new ZaloChatService(
      buildConfig(),
      { sendText } as unknown as ZaloOutboundService,
      {} as unknown as ZaloAccountLinkService,
      {} as unknown as ZaloChatQueueService,
      NO_RESCHEDULE,
    );

    await service.handleUnsupportedMessage('zalo-1');

    expect(sendText).toHaveBeenCalledWith(
      'zalo-1',
      expect.stringContaining('văn bản'),
    );
  });
});
