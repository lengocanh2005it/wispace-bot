import { Injectable } from '@nestjs/common';
import { RescheduleConfirmationService } from '@wispace/reschedule-confirm';
import { ZaloCalendarPort } from '../../infrastructure/adapters/zalo-calendar.port';
import { ZaloReschedulePort } from '../../infrastructure/adapters/zalo-reschedule.port';

/**
 * Zalo-specific reschedule confirmation — wraps the shared
 * RescheduleConfirmationService<string> with Zalo ports.
 */
@Injectable()
export class ZaloRescheduleConfirmationService extends RescheduleConfirmationService<string> {
  constructor(
    calendarPort: ZaloCalendarPort,
    reschedulePort: ZaloReschedulePort,
  ) {
    super(calendarPort, reschedulePort);
  }
}
