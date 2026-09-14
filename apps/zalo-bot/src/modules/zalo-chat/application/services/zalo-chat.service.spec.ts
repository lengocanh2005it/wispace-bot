import type { ConfigService } from '@nestjs/config';
import { ZaloChatService } from './zalo-chat.service';
import { ZaloOutboundService } from './zalo-outbound.service';
import { ZaloAccountLinkService } from '@zalo/modules/zalo-oauth/application/services/zalo-account-link.service';
import { PlatformChatQueueService } from '@wispace/chat-agent';
import type { ZaloClarificationAgentPort } from '../ports/zalo-clarification-agent.port';
import { RescheduleConfirmationService } from '@wispace/reschedule-confirm';
import { NotificationPreferenceService } from '@wispace/database';
import { ZaloWelcomeService } from '@zalo/modules/zalo-oauth/application/services/zalo-welcome.service';

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

  it('does not let bare ok confirm a pending reschedule', async () => {
    const sendText = jest.fn().mockResolvedValue(undefined);
    const enqueue = jest.fn();
    const reschedule = {
      hasPending: jest.fn().mockResolvedValue(true),
      getPendingState: jest.fn().mockResolvedValue('pending'),
      confirm: jest.fn(),
      cancel: jest.fn(),
    } as unknown as RescheduleConfirmationService<string>;

    const service = new ZaloChatService(
      buildConfig(),
      { sendText } as unknown as ZaloOutboundService,
      {
        findUserIdByZaloId: jest.fn().mockResolvedValue(42),
      } as unknown as ZaloAccountLinkService,
      { enqueue } as unknown as PlatformChatQueueService,
      reschedule,
      makePrefs(),
    );

    await service.handleIncomingMessage('zalo-1', 'ok');

    expect((reschedule.confirm as jest.Mock).mock.calls).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      'zalo-1',
      expect.stringContaining('mã'),
      { userId: 42 },
    );
  });

  it('confirms only an exact tokenized Zalo approval', async () => {
    const token = '00000000-0000-4000-8000-000000000000';
    const sendText = jest.fn().mockResolvedValue(undefined);
    const enqueue = jest.fn();
    const confirm = jest.fn().mockResolvedValue({
      confirmed: true,
      scheduledTimeLabel: 'Ngày mai lúc 19:00',
    });
    const reschedule = {
      getPendingState: jest.fn().mockResolvedValue('pending'),
      confirm,
      cancel: jest.fn(),
    } as unknown as RescheduleConfirmationService<string>;

    const service = new ZaloChatService(
      buildConfig(),
      { sendText } as unknown as ZaloOutboundService,
      {
        findCurrentIdentity: jest.fn().mockResolvedValue({
          userId: 42,
          mappingVersion: 'mapping-1',
        }),
        findUserIdByZaloId: jest.fn().mockResolvedValue(42),
      } as unknown as ZaloAccountLinkService,
      { enqueue } as unknown as PlatformChatQueueService,
      reschedule,
      makePrefs(),
    );

    await service.handleIncomingMessage('zalo-1', `xác nhận ${token}`);

    expect(confirm).toHaveBeenCalledWith('zalo-1', 42, token, {
      platform: 'zalo',
      mappingVersion: 'mapping-1',
    });
    expect(sendText).toHaveBeenCalledWith(
      'zalo-1',
      expect.stringContaining('Ngày mai lúc 19:00'),
      { userId: 42 },
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects a stale token when no proposal is pending', async () => {
    const token = '00000000-0000-4000-8000-000000000000';
    const sendText = jest.fn().mockResolvedValue(undefined);
    const enqueue = jest.fn();
    const reschedule = {
      getPendingState: jest.fn().mockResolvedValue('none'),
      confirm: jest.fn(),
    } as unknown as RescheduleConfirmationService<string>;

    const service = new ZaloChatService(
      buildConfig(),
      { sendText } as unknown as ZaloOutboundService,
      {
        findUserIdByZaloId: jest.fn().mockResolvedValue(42),
      } as unknown as ZaloAccountLinkService,
      { enqueue } as unknown as PlatformChatQueueService,
      reschedule,
      makePrefs(),
    );

    await service.handleIncomingMessage('zalo-1', token);

    expect(reschedule.confirm).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      'zalo-1',
      expect.stringContaining('xác thực'),
      { userId: 42 },
    );
  });

  it.each([
    'Mã: 00000000-0000-4000-8000-000000000000',
    'xác nhận 00000000-0000-4000-8000-000000000000 nhé',
    'xác nhận không-phải-mã',
  ])(
    'rejects malformed confirmation syntax without a proposal: %s',
    async (text) => {
      const sendText = jest.fn().mockResolvedValue(undefined);
      const enqueue = jest.fn();
      const reschedule = {
        getPendingState: jest.fn().mockResolvedValue('none'),
        confirm: jest.fn(),
      } as unknown as RescheduleConfirmationService<string>;

      const service = new ZaloChatService(
        buildConfig(),
        { sendText } as unknown as ZaloOutboundService,
        {
          findUserIdByZaloId: jest.fn().mockResolvedValue(42),
        } as unknown as ZaloAccountLinkService,
        { enqueue } as unknown as PlatformChatQueueService,
        reschedule,
        makePrefs(),
      );

      await service.handleIncomingMessage('zalo-1', text);

      expect(reschedule.confirm).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
      expect(sendText).toHaveBeenCalledWith(
        'zalo-1',
        expect.stringContaining('xác thực'),
        { userId: 42 },
      );
    },
  );

  it('rejects a token followed by trailing prose', async () => {
    const token = '00000000-0000-4000-8000-000000000000';
    const sendText = jest.fn().mockResolvedValue(undefined);
    const enqueue = jest.fn();
    const reschedule = {
      getPendingState: jest.fn().mockResolvedValue('pending'),
      confirm: jest.fn(),
    } as unknown as RescheduleConfirmationService<string>;

    const service = new ZaloChatService(
      buildConfig(),
      { sendText } as unknown as ZaloOutboundService,
      {
        findUserIdByZaloId: jest.fn().mockResolvedValue(42),
      } as unknown as ZaloAccountLinkService,
      { enqueue } as unknown as PlatformChatQueueService,
      reschedule,
      makePrefs(),
    );

    await service.handleIncomingMessage('zalo-1', `${token} nhé`);

    expect(reschedule.confirm).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      'zalo-1',
      expect.stringContaining('mã'),
      { userId: 42 },
    );
  });

  it('rejects a copied Mã prefix as an invalid confirmation', async () => {
    const token = '00000000-0000-4000-8000-000000000000';
    const sendText = jest.fn().mockResolvedValue(undefined);
    const enqueue = jest.fn();
    const reschedule = {
      getPendingState: jest.fn().mockResolvedValue('pending'),
      confirm: jest.fn(),
      cancel: jest.fn(),
    } as unknown as RescheduleConfirmationService<string>;

    const service = new ZaloChatService(
      buildConfig(),
      { sendText } as unknown as ZaloOutboundService,
      {
        findUserIdByZaloId: jest.fn().mockResolvedValue(42),
      } as unknown as ZaloAccountLinkService,
      { enqueue } as unknown as PlatformChatQueueService,
      reschedule,
      makePrefs(),
    );

    await service.handleIncomingMessage('zalo-1', `Mã: ${token}`);

    expect((reschedule.confirm as jest.Mock).mock.calls).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      'zalo-1',
      expect.stringContaining('mã'),
      { userId: 42 },
    );
  });

  it('clears clarification state when a pending reschedule is cancelled', async () => {
    const sendText = jest.fn().mockResolvedValue(undefined);
    const enqueue = jest.fn();
    const cancel = jest.fn().mockResolvedValue('Đã hủy yêu cầu đổi lịch.');
    const clearClarificationState = jest.fn().mockResolvedValue(undefined);
    const reschedule = {
      getPendingState: jest.fn().mockResolvedValue('pending'),
      cancel,
    } as unknown as RescheduleConfirmationService<string>;

    const service = new ZaloChatService(
      buildConfig(),
      { sendText } as unknown as ZaloOutboundService,
      {
        findUserIdByZaloId: jest.fn().mockResolvedValue(42),
      } as unknown as ZaloAccountLinkService,
      { enqueue } as unknown as PlatformChatQueueService,
      reschedule,
      makePrefs(),
      undefined,
      undefined,
      { clearClarificationState } as unknown as ZaloClarificationAgentPort,
    );

    await service.handleIncomingMessage('zalo-1', 'hủy');

    expect(cancel).toHaveBeenCalledWith('zalo-1');
    expect(clearClarificationState).toHaveBeenCalledWith('zalo-1');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('reports expiry for a related confirmation after the TTL', async () => {
    const sendText = jest.fn().mockResolvedValue(undefined);
    const enqueue = jest.fn();
    const reschedule = {
      getPendingState: jest.fn().mockResolvedValue('expired'),
      confirm: jest.fn(),
      cancel: jest.fn(),
    } as unknown as RescheduleConfirmationService<string>;

    const service = new ZaloChatService(
      buildConfig(),
      { sendText } as unknown as ZaloOutboundService,
      {
        findUserIdByZaloId: jest.fn().mockResolvedValue(42),
      } as unknown as ZaloAccountLinkService,
      { enqueue } as unknown as PlatformChatQueueService,
      reschedule,
      makePrefs(),
    );

    await service.handleIncomingMessage('zalo-1', 'ok');

    expect(sendText).toHaveBeenCalledWith(
      'zalo-1',
      expect.stringContaining('hết hạn'),
      { userId: 42 },
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('keeps an expired proposal for the next related interaction after unrelated chat', async () => {
    const sendText = jest.fn().mockResolvedValue(undefined);
    const enqueue = jest.fn().mockResolvedValue(undefined);
    const getPendingState = jest.fn().mockResolvedValue('expired');
    const reschedule = {
      getPendingState,
      confirm: jest.fn(),
      cancel: jest.fn(),
    } as unknown as RescheduleConfirmationService<string>;

    const service = new ZaloChatService(
      buildConfig(),
      { sendText } as unknown as ZaloOutboundService,
      {
        findUserIdByZaloId: jest.fn().mockResolvedValue(42),
      } as unknown as ZaloAccountLinkService,
      { enqueue } as unknown as PlatformChatQueueService,
      reschedule,
      makePrefs(),
    );

    await service.handleIncomingMessage('zalo-1', 'hỏi mình bài tập nhé');
    expect(getPendingState).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalled();

    await service.handleIncomingMessage('zalo-1', 'ok');
    expect(getPendingState).toHaveBeenCalledWith('zalo-1');
    expect(sendText).toHaveBeenCalledWith(
      'zalo-1',
      expect.stringContaining('hết hạn'),
      { userId: 42 },
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

  it.each(['chao ban', 'ban la ai', 'hi', 'giới thiệu', 'bạn là ai vậy'])(
    'replies directly to no-diacritic intent "%s" without enqueueing',
    async (text) => {
      const sendText = jest.fn().mockResolvedValue(undefined);
      const enqueue = jest.fn();

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

      await service.handleIncomingMessage('zalo-1', text);

      expect(sendText).toHaveBeenCalledWith(
        'zalo-1',
        expect.stringContaining('WISPACE'),
      );
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it.each([
    'Hi, cho mình hỏi cách viết Task 2 với',
    'Chào bạn, mình muốn xem tiến độ học',
    'Hello, can you check my essay please?',
    'Xin chào, lịch học tuần này thế nào ạ',
    'Hey bạn, band mục tiêu của mình là bao nhiêu',
    'chào bạn mình bị áp lực thi quá',
    'giới thiệu về cấu trúc Task 1 giúp mình',
    'giới thiệu bài mẫu band 7 cho mình',
    'bạn là ai, giúp mình kiểm tra bài viết',
    'Cho mình hỏi cách viết Task 2',
  ])('queues content after standalone wording: "%s"', async (text) => {
    const sendText = jest.fn().mockResolvedValue(undefined);
    const enqueue = jest.fn().mockResolvedValue(undefined);

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

    await service.handleIncomingMessage('zalo-1', text, 'message-941');

    expect(sendText).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      'zalo-1',
      text,
      { userId: 42 },
      'message-941',
    );
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
      { userId: 42 },
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

  it('routes follow welcome through the dedupe service when available', async () => {
    const sendText = jest.fn().mockResolvedValue(undefined);
    const organicWelcomeIfDue = jest.fn().mockResolvedValue('sent');
    const service = new ZaloChatService(
      buildConfig(),
      { sendText } as unknown as ZaloOutboundService,
      {} as unknown as ZaloAccountLinkService,
      {} as unknown as PlatformChatQueueService,
      NO_RESCHEDULE,
      makePrefs(),
      undefined,
      { organicWelcomeIfDue } as unknown as ZaloWelcomeService,
    );

    await service.handleFollow('zalo-1');

    expect(organicWelcomeIfDue).toHaveBeenCalledWith(
      'zalo-1',
      expect.stringContaining('WISPACE'),
    );
    expect(sendText).not.toHaveBeenCalled();
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
