import type {
  CalendarPort,
  CalendarEntryView,
} from '@wispace/reschedule-confirm';

export type ListUpcomingFn = (
  externalId: string,
  userId: number,
) => Promise<CalendarEntryView[]>;

/**
 * Generic CalendarPort that delegates to a provided list function.
 * Used by Discord and Messenger adapters to avoid duplicating the
 * CalendarPort → CalendarEntryView mapping.
 */
export class GenericCalendarPort implements CalendarPort<string> {
  constructor(private readonly listFn: ListUpcomingFn) {}

  listUpcomingEntries(
    externalId: string,
    userId: number,
  ): Promise<CalendarEntryView[]> {
    return this.listFn(externalId, userId);
  }
}
