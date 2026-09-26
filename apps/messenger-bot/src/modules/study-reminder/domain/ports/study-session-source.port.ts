import type { NormalizedStudySession } from '../entities/study-schedule.types';

export const STUDY_SESSION_SOURCE = Symbol('STUDY_SESSION_SOURCE');

/** Upcoming-session reads; the calendar client stays an adapter concern. */
export interface StudySessionSourcePort {
  getUpcomingSessions(params: {
    psid: string;
    userId?: number;
    horizonEnd: Date;
  }): Promise<NormalizedStudySession[]>;
}
