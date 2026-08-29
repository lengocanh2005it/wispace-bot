import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  buildConsentChangedMessage,
  parseConsentCommand,
  type ConsentCommand,
} from '@wispace/bot-common/messages';
import { maskExternalId } from '@wispace/bot-common/masking';
import { NotificationPreferenceService } from '@wispace/database';
import {
  STUDY_REMINDER_JOB_REPOSITORY,
  type StudyReminderJobRepositoryPort,
} from '@wispace/study-reminder-shared';
import { DiscordAccountLinkService } from '@discord/modules/account-link/application/services/discord-account-link.service';
import { DiscordOutboundService } from './discord-outbound.service';

/**
 * Deterministic consent commands (#596): report/reminder opt-in and opt-out.
 * Handled before the LLM pipeline — consent never depends on intent detection
 * and never consumes chat quota.
 */
@Injectable()
export class DiscordConsentService {
  private readonly logger = new Logger(DiscordConsentService.name);

  constructor(
    private readonly accountLinkService: DiscordAccountLinkService,
    private readonly outboundService: DiscordOutboundService,
    private readonly notificationPreferences: NotificationPreferenceService,
    @Optional()
    @Inject(STUDY_REMINDER_JOB_REPOSITORY)
    private readonly studyReminderJobRepository?: StudyReminderJobRepositoryPort,
  ) {}

  /** Returns true when the message was a consent command (handled). */
  async handleIfConsentCommand(
    discordUserId: string,
    userText: string,
  ): Promise<boolean> {
    const command = parseConsentCommand(userText);
    if (!command) return false;

    const userId =
      await this.accountLinkService.findUserIdByDiscordId(discordUserId);
    if (userId === undefined) {
      await this.outboundService.sendText(
        discordUserId,
        'Bạn cần liên kết tài khoản WISPACE trước khi bật/tắt báo cáo và nhắc học nhé.',
      );
      return true;
    }

    await this.applyCommand(discordUserId, userId, command);
    await this.outboundService.sendText(
      discordUserId,
      buildConsentChangedMessage(command.feature, command.action === 'enable'),
    );
    return true;
  }

  private async applyCommand(
    discordUserId: string,
    userId: number,
    command: ConsentCommand,
  ): Promise<void> {
    const enable = command.action === 'enable';
    if (command.feature === 'report') {
      await this.notificationPreferences.setReportEnabled(userId, enable);
      if (enable) {
        // Explicit opt-in knows the toggle — suppress the opt-out footer.
        await this.accountLinkService
          .suppressOptOutNotice(discordUserId)
          .catch(() => undefined);
      }
      return;
    }

    await this.notificationPreferences.setReminderEnabled(userId, enable);
    if (!enable) {
      const cancelled =
        (await this.studyReminderJobRepository?.cancelPendingJobsForExternalUser(
          'discord',
          discordUserId,
        )) ?? 0;
      this.logger.log(
        `Reminder opt-out cancelled ${cancelled} jobs for discordUserId=${maskExternalId(
          discordUserId,
        )}`,
      );
    }
  }
}
