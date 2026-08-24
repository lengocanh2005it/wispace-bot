import { Injectable } from '@nestjs/common';
import {
  RescheduleConfirmationService,
  type CalendarPort,
  type ReschedulePort,
  type RescheduleStorePort,
} from '@wispace/reschedule-confirm';
import { buildRescheduleConfirmFollowUp } from '../formatters/messenger-rich-message.builder';
import type { MessengerStageResult } from '../types/messenger-reschedule-confirmation.types';

/**
 * Messenger-specific reschedule confirmation — extends shared service
 * with Messenger rich follow-up formatting.
 */
@Injectable()
export class MessengerRescheduleConfirmationService extends RescheduleConfirmationService<string> {
  constructor(
    calendarPort: CalendarPort<string>,
    reschedulePort: ReschedulePort<string>,
    store?: RescheduleStorePort<string>,
  ) {
    super(calendarPort, reschedulePort, store);
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
