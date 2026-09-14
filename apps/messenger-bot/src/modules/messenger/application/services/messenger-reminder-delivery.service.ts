import { Inject, Injectable, Logger } from '@nestjs/common';
import { getNoUpcomingStudySessionMessage } from '../messages/messenger-reminder.messages';
import {
  STUDY_REMINDER_OPERATIONS_PORT,
  type NormalizedStudySession,
  type StudyReminderOperationsPort,
} from '@messenger/modules/study-reminder/domain/ports/study-reminder-operations.port';
import { MessengerOutboundService } from './messenger-outbound.service';

@Injectable()
export class MessengerReminderDeliveryService {
  private readonly logger = new Logger(MessengerReminderDeliveryService.name);

  constructor(
    private readonly outbound: MessengerOutboundService,
    @Inject(STUDY_REMINDER_OPERATIONS_PORT)
    private readonly studyReminder: StudyReminderOperationsPort,
  ) {}

  async sendReminderPreview(psid: string, userId?: number): Promise<string> {
    const session = await this.studyReminder.getNextUpcomingSession(
      psid,
      userId,
    );

    if (!session) {
      const emptyMessage = getNoUpcomingStudySessionMessage(
        this.studyReminder.getOutboxSettings().minutesBefore,
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
    const { text: reminder } =
      await this.studyReminder.generateReminderBundleForSession(
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
