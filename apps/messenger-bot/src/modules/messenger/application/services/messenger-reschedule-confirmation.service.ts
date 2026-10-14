import { Injectable } from '@nestjs/common';
import {
  RESCHEDULE_INVALID_TOKEN_MESSAGE,
  RescheduleConfirmationService,
} from '@wispace/reschedule-confirm/core';
import type {
  CalendarPort,
  ReschedulePort,
  RescheduleStorePort,
  RescheduleConfirmationOptions,
} from '@wispace/reschedule-confirm/core';
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
    options?: RescheduleConfirmationOptions<string>,
  ) {
    super(calendarPort, reschedulePort, store, options);
  }

  async stage(input: {
    externalId: string;
    userId: number;
    calendarId: number;
    schedulingMode: import('@wispace/wispace-client/core').RescheduleSchedulingMode;
    newLocalDate?: string;
    newTime?: string;
    platform?: string;
    mappingVersion?: string;
    intent?: string;
    canonicalArgs?: string;
    signal?: AbortSignal;
  }): Promise<MessengerStageResult | { error: string }> {
    const result = await super.stage(input);
    if ('error' in result) {
      return result;
    }
    // Unreachable in practice: `stage` always mints the nonce. The field is
    // optional only so the non-enumerable token stays out of legacy response
    // shapes, so failing closed costs nothing and a proposal button is never
    // emitted that no approval token can act on.
    if (!result.confirmationToken) {
      return { error: RESCHEDULE_INVALID_TOKEN_MESSAGE };
    }
    const messengerResult = {
      ...result,
      richFollowUp: buildRescheduleConfirmFollowUp({
        summary: result.summary,
        confirmationToken: result.confirmationToken,
      }),
    };
    Object.defineProperty(messengerResult, 'confirmationToken', {
      value: result.confirmationToken,
      enumerable: false,
    });
    return messengerResult;
  }
}
