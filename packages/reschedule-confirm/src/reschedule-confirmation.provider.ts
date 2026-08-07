import type { Provider, Type } from '@nestjs/common';
import {
  RescheduleConfirmationService,
  type CalendarPort,
  type ReschedulePort,
} from './reschedule-confirm.service';

/**
 * NestJS provider factory for `RescheduleConfirmationService` — replaces the
 * near-identical `useFactory` blocks in the Discord and Zalo chat modules.
 * Generic over the platform external id type (psid / discordUserId / zaloUserId).
 */
export function createRescheduleConfirmationProvider<TExternalId = string>(
  calendarPort: Type<CalendarPort<TExternalId>>,
  reschedulePort: Type<ReschedulePort<TExternalId>>,
): Provider {
  return {
    provide: RescheduleConfirmationService,
    useFactory: (
      calendar: CalendarPort<TExternalId>,
      reschedule: ReschedulePort<TExternalId>,
    ) => new RescheduleConfirmationService<TExternalId>(calendar, reschedule),
    inject: [calendarPort, reschedulePort],
  };
}
