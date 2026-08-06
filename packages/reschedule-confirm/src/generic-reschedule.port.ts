import type { RescheduleSchedulingMode } from '@wispace/wispace-client';
import type {
  ReschedulePort,
  RescheduleResult,
} from './reschedule-confirm.service';

export type RescheduleFn = (params: {
  externalUserId: string;
  userId: number;
  calendarId: number;
  schedulingMode: RescheduleSchedulingMode;
  newLocalDate?: string;
  newTime?: string;
}) => Promise<RescheduleResult>;

export class GenericReschedulePort implements ReschedulePort<string> {
  constructor(private readonly fn: RescheduleFn) {}

  async rescheduleSession(params: {
    externalId: string;
    userId: number;
    calendarId: number;
    schedulingMode: RescheduleSchedulingMode;
    newLocalDate?: string;
    newTime?: string;
  }): Promise<RescheduleResult> {
    return this.fn({
      externalUserId: params.externalId,
      userId: params.userId,
      calendarId: params.calendarId,
      schedulingMode: params.schedulingMode,
      newLocalDate: params.newLocalDate,
      newTime: params.newTime,
    });
  }
}
