import type { ConfigService } from '@nestjs/config';
import { ZaloChatService } from './zalo-chat.service';
import { ZaloOutboundService } from './zalo-outbound.service';
import { ZaloAccountLinkService } from '@zalo/modules/zalo-oauth/application/services/zalo-account-link.service';
import { PlatformChatQueueService } from '@wispace/chat-agent';
import { RescheduleConfirmationService } from '@wispace/reschedule-confirm';
import { NotificationPreferenceService } from '@wispace/database';

const NO_RESCHEDULE = {
  hasPending: jest.fn().mockResolvedValue(false),
} as unknown as RescheduleConfirmationService<string>;

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
  const makePrefs = () =>
    ({
      setReportEnabled: jest.fn().mockResolvedValue(undefined),
      setReminderEnabled: jest.fn().mockResolvedValue(undefined),
    }) as unknown as NotificationPreferenceService;

  it('enqueues message and resolves userId', async () => {
    const findUserIdByZaloId = jest.fn().mockResolvedValue(42);
    const enqueue = jest.fn();

    const service = new ZaloChatService(
      buildConfig(),
      {} as unknown as ZaloOutboundService,
      { findUserIdByZaloId } as unknown as ZaloAccountLinkService,
      { enqueue } as unknown as PlatformChatQueueService,
      NO_RESCHEDULE,
      makePrefs(),
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

  it('propagates queue write failures so the durable inbox can retry', async () => {
    const enqueue = jest.fn().mockRejectedValue(new Error('Redis unavailable'));
    const sendText = jest.fn().mockResolvedValue(undefined);
    const service = new ZaloChatService(
      buildConfig(),
      { sendText } as unknown as ZaloOutboundService,
      {
        findUserIdByZaloId: jest.fn().mockResolvedValue(42),
      } as unknown as ZaloAccountLinkService,
      { enqueue } as unknown as PlatformChatQueueService,
      NO_RESCHEDULE,
      makePrefs(),
    );

    await expect(
      service.handleIncomingMessage('zalo-1', 'xem lich hoc cua minh'),
    ).rejects.toThrow('Redis unavailable');
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('replies directly to greeting without enqueueing', async () => {
    const sendText = jest.fn().mockResolvedValue(undefined);
    const enqueue = jest.fn();

    const service = new ZaloChatService(
      buildConfig(),
      { sendText } as unknown as ZaloOutboundService,
      {} as unknown as ZaloAccountLinkService,
      { enqueue } as unknown as PlatformChatQueueService,
      NO_RESCHEDULE,
      makePrefs(),
    );

    await service.handleIncomingMessage('zalo-1', 'chào bạn');

    expect(sendText).toHaveBeenCalledWith(
      'zalo-1',
      expect.stringContaining('WISPACE'),
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('handles consent commands deterministically — cancels pending reminders on opt-out (#596)', async () => {
    const sendText = jest.fn().mockResolvedValue(undefined);
    const enqueue = jest.fn();
    const cancelPendingJobsForExternalUser = jest.fn().mockResolvedValue(2);

    const service = new ZaloChatService(
      buildConfig(),
      { sendText } as unknown as ZaloOutboundService,
      {
        findUserIdByZaloId: jest.fn().mockResolvedValue(42),
        suppressOptOutNotice: jest.fn().mockResolvedValue(undefined),
      } as unknown as ZaloAccountLinkService,
      { enqueue } as unknown as PlatformChatQueueService,
      NO_RESCHEDULE,
      makePrefs(),
      {
        cancelPendingJobsForExternalUser,
      } as never,
    );

    await service.handleIncomingMessage('zalo-1', 'Tắt nhắc học');

    const prefs = service['notificationPreferences'];
    expect(prefs.setReminderEnabled).toHaveBeenCalledWith(42, false);
    expect(cancelPendingJobsForExternalUser).toHaveBeenCalledWith(
      'zalo',
      'zalo-1',
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      'zalo-1',
      expect.stringContaining('TẮT'),
    );
  });

  it('enables reports via command and suppresses the opt-out footer (#596)', async () => {
    const sendText = jest.fn().mockResolvedValue(undefined);
    const suppressOptOutNotice = jest.fn().mockResolvedValue(undefined);

    const service = new ZaloChatService(
      buildConfig(),
      { sendText } as unknown as ZaloOutboundService,
      {
        findUserIdByZaloId: jest.fn().mockResolvedValue(42),
        suppressOptOutNotice,
      } as unknown as ZaloAccountLinkService,
      {} as unknown as PlatformChatQueueService,
      NO_RESCHEDULE,
      makePrefs(),
    );

    await service.handleIncomingMessage('zalo-1', 'bật báo cáo');

    const prefs = service['notificationPreferences'];
    expect(prefs.setReportEnabled).toHaveBeenCalledWith(42, true);
    expect(suppressOptOutNotice).toHaveBeenCalledWith('zalo-1');
  });

  it('replies with a link hint when a consent command arrives unlinked (#596)', async () => {
    const sendText = jest.fn().mockResolvedValue(undefined);

    const service = new ZaloChatService(
      buildConfig(),
      { sendText } as unknown as ZaloOutboundService,
      {
        findUserIdByZaloId: jest.fn().mockResolvedValue(undefined),
      } as unknown as ZaloAccountLinkService,
      {} as unknown as PlatformChatQueueService,
      NO_RESCHEDULE,
      makePrefs(),
    );

    await service.handleIncomingMessage('zalo-1', 'bật báo cáo');

    expect(sendText).toHaveBeenCalledWith(
      'zalo-1',
      expect.stringContaining('liên kết'),
    );
  });

  it('sends a welcome message on follow', async () => {
    const sendText = jest.fn().mockResolvedValue(undefined);
    const service = new ZaloChatService(
      buildConfig(),
      { sendText } as unknown as ZaloOutboundService,
      {} as unknown as ZaloAccountLinkService,
      {} as unknown as PlatformChatQueueService,
      NO_RESCHEDULE,
      makePrefs(),
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
      {} as unknown as PlatformChatQueueService,
      NO_RESCHEDULE,
      makePrefs(),
    );

    await service.handleUnsupportedMessage('zalo-1');

    expect(sendText).toHaveBeenCalledWith(
      'zalo-1',
      expect.stringContaining('văn bản'),
    );
  });
});
