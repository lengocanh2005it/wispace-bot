import { DiscordConsentService } from './discord-consent.service';
import type { DiscordAccountLinkService } from '@discord/modules/account-link/application/services/discord-account-link.service';
import type { DiscordOutboundService } from './discord-outbound.service';
import type { NotificationPreferenceService } from '@wispace/database';
import type { StudyReminderJobRepositoryPort } from '@wispace/study-reminder-shared';

describe('DiscordConsentService (#596)', () => {
  const buildService = (
    overrides: {
      userId?: number | undefined;
    } = {},
  ) => {
    const accountLinkService = {
      findUserIdByDiscordId:
        'userId' in overrides
          ? jest.fn().mockResolvedValue(overrides.userId)
          : jest.fn().mockResolvedValue(42),
      suppressOptOutNotice: jest.fn().mockResolvedValue(undefined),
    } as unknown as DiscordAccountLinkService;
    const outboundService = {
      sendText: jest.fn().mockResolvedValue(undefined),
    } as unknown as DiscordOutboundService;
    const notificationPreferences = {
      setReportEnabled: jest.fn().mockResolvedValue(undefined),
      setReminderEnabled: jest.fn().mockResolvedValue(undefined),
    } as unknown as NotificationPreferenceService;
    const studyReminderJobRepository = {
      cancelPendingJobsForExternalUser: jest.fn().mockResolvedValue(3),
    } as unknown as StudyReminderJobRepositoryPort;

    const service = new DiscordConsentService(
      accountLinkService,
      outboundService,
      notificationPreferences,
      studyReminderJobRepository,
    );
    return {
      service,
      accountLinkService,
      outboundService,
      notificationPreferences,
      studyReminderJobRepository,
    };
  };

  it('returns false for non-consent text without touching anything', async () => {
    const { service, notificationPreferences, outboundService } =
      buildService();

    const handled = await service.handleIfConsentCommand(
      'discord-1',
      'xem lich hoc cua minh',
    );

    expect(handled).toBe(false);
    expect(notificationPreferences.setReportEnabled).not.toHaveBeenCalled();
    expect(outboundService.sendText).not.toHaveBeenCalled();
  });

  it('enables reports and suppresses the opt-out footer (#596 AC6)', async () => {
    const { service, notificationPreferences, accountLinkService } =
      buildService();

    const handled = await service.handleIfConsentCommand(
      'discord-1',
      'Bật báo cáo',
    );

    expect(handled).toBe(true);
    expect(notificationPreferences.setReportEnabled).toHaveBeenCalledWith(
      42,
      true,
    );
    expect(accountLinkService.suppressOptOutNotice).toHaveBeenCalledWith(
      'discord-1',
    );
  });

  it('disables reminders and cancels pending jobs immediately (#596 AC6)', async () => {
    const { service, notificationPreferences, studyReminderJobRepository } =
      buildService();

    await service.handleIfConsentCommand('discord-1', 'Tắt nhắc học');

    expect(notificationPreferences.setReminderEnabled).toHaveBeenCalledWith(
      42,
      false,
    );
    expect(
      studyReminderJobRepository.cancelPendingJobsForExternalUser,
    ).toHaveBeenCalledWith('discord', 'discord-1');
  });

  it('replies with a link hint when the learner is not linked', async () => {
    const { service, outboundService } = buildService({ userId: undefined });

    await service.handleIfConsentCommand('discord-1', 'bật báo cáo');

    expect(outboundService.sendText).toHaveBeenCalledWith(
      'discord-1',
      expect.stringContaining('liên kết'),
    );
  });
});
