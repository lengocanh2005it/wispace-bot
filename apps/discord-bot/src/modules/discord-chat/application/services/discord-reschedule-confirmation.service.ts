import { Injectable } from '@nestjs/common';
import { RescheduleConfirmationService } from '@wispace/reschedule-confirm';
import { DiscordCalendarPort } from '../../infrastructure/adapters/discord-calendar.port';
import { DiscordReschedulePort } from '../../infrastructure/adapters/discord-reschedule.port';

/**
 * Discord-specific reschedule confirmation — wraps the shared
 * RescheduleConfirmationService<string> with Discord ports.
 */
@Injectable()
export class DiscordRescheduleConfirmationService extends RescheduleConfirmationService<string> {
  constructor(
    calendarPort: DiscordCalendarPort,
    reschedulePort: DiscordReschedulePort,
  ) {
    super(calendarPort, reschedulePort);
  }
}
