import { Injectable } from '@nestjs/common';
import {
  RescheduleConfirmationService,
  type StageResult,
} from '@wispace/reschedule-confirm';
import { buildRescheduleConfirmFollowUp } from '../formatters/messenger-rich-message.builder';
import type { MessengerRichFollowUp } from '../../domain/entities/messenger-rich-message.types';
import { MessengerCalendarPort } from '../../infrastructure/adapters/messenger-calendar.port';
import { MessengerReschedulePort } from '../../infrastructure/adapters/messenger-reschedule.port';

export interface MessengerStageResult extends StageResult {
  richFollowUp: MessengerRichFollowUp;
}

/**
 * Messenger-specific reschedule confirmation — extends shared service
 * with Messenger rich follow-up formatting.
 */
@Injectable()
export class MessengerRescheduleConfirmationService extends RescheduleConfirmationService<string> {
  constructor(
    calendarPort: MessengerCalendarPort,
    reschedulePort: MessengerReschedulePort,
  ) {
    super(calendarPort, reschedulePort);
  }

  async stage(input: {
    externalId: string;
    userId: number;
    calendarId: number;
    schedulingMode: import('@wispace/wispace-client').RescheduleSchedulingMode;
    newLocalDate?: string;
    newTime?: string;
  }): Promise<MessengerStageResult | { error: string }> {
    const result = await super.stage(input);
    if ('error' in result) {
      return result;
    }
    return {
      ...result,
      richFollowUp: buildRescheduleConfirmFollowUp({ summary: result.summary }),
    };
  }
}
