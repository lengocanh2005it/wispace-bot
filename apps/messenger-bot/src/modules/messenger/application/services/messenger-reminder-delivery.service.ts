import { Injectable, Logger } from '@nestjs/common';
import { getNoUpcomingStudySessionMessage } from '@messenger/modules/study-reminder/application/messages/study-reminder.messages';
import { StudyReminderScheduleService } from '@wispace/study-reminder-shared';
import { StudyReminderService } from '@messenger/modules/study-reminder/application/services/study-reminder.service';
import type { NormalizedStudySession } from '@messenger/modules/study-reminder/domain/ports/study-reminder-operations.port';
import { MessengerOutboundService } from './messenger-outbound.service';

@Injectable()
export class MessengerReminderDeliveryService {
  private readonly logger = new Logger(MessengerReminderDeliveryService.name);

  constructor(
    private readonly outbound: MessengerOutboundService,
    private readonly studyReminderService: StudyReminderService,
    private readonly studyReminderScheduleService: StudyReminderScheduleService,
  ) {}

  async sendReminderPreview(psid: string, userId?: number): Promise<string> {
    const session = await this.studyReminderService.getNextUpcomingSession(
      psid,
      userId,
    );

    if (!session) {
      const emptyMessage = getNoUpcomingStudySessionMessage(
        this.studyReminderScheduleService.getOutboxSettings().minutesBefore,
      );
      await this.outbound.sendTextViaPsid({
        psid,
        userId,
        text: emptyMessage,
        messageType: 'STUDY_SESSION_REMINDER_EMPTY',
      });
      return emptyMessage;
    }

    return this.sendReminder({
      psid,
      userId,
      session,
      messageType: 'STUDY_SESSION_REMINDER_PREVIEW',
    });
  }

  async sendReminder(params: {
    psid: string;
    session: NormalizedStudySession;
    messageType: string;
    userId?: number;
    displayName?: string;
  }): Promise<string> {
    const reminder = await this.studyReminderService.generateReminderForSession(
      params.psid,
      params.session,
      { userId: params.userId, displayName: params.displayName },
    );

    await this.outbound.sendTextViaPsid({
      psid: params.psid,
      userId: params.userId,
      text: reminder,
      messageType: params.messageType,
    });

    return reminder;
  }
}
