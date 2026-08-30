import type {
  CalendarCapabilityPort,
  ExerciseCapabilityPort,
  GoalsCapabilityPort,
  WispaceCalendarSessionView,
  WispaceExercisePrecreateResult,
  WispaceGoalsRecord,
  WispaceTaskScoreView,
} from '@wispace/chat-agent';
import {
  PrecreateExerciseApiClient,
  WispaceCalendarService,
  WispaceGoalsService,
} from '@wispace/wispace-client';

/**
 * Wire the concrete wispace-client services to the chat-agent capability
 * ports (#425). The Zalo identity header is baked here — no default exists
 * in the shared package.
 */

export class ZaloGoalsCapabilityAdapter implements GoalsCapabilityPort {
  constructor(private readonly goalsService: WispaceGoalsService) {}

  getUserGoals(
    externalId: string,
    options?: { signal?: AbortSignal },
  ): Promise<WispaceGoalsRecord> {
    return this.goalsService.getUserGoals(externalId, options);
  }

  getTaskScoreAverages(
    externalId: string,
    options?: { signal?: AbortSignal },
  ): Promise<WispaceTaskScoreView[]> {
    return this.goalsService.getTaskScoreAverages(externalId, options);
  }
}

export class ZaloCalendarCapabilityAdapter implements CalendarCapabilityPort {
  constructor(private readonly calendarService: WispaceCalendarService) {}

  getCalendarSessions(
    externalId: string,
    options?: {
      timeRange?: 'upcoming' | 'past' | 'all';
      pastDays?: number;
      limit?: number;
      signal?: AbortSignal;
    },
  ): Promise<WispaceCalendarSessionView[]> {
    return this.calendarService.getCalendarSessions(externalId, options);
  }
}

export class ZaloExerciseCapabilityAdapter implements ExerciseCapabilityPort {
  constructor(
    private readonly exerciseClient: PrecreateExerciseApiClient,
    private readonly idHeader: 'x-zaloid',
  ) {}

  precreateNextExercise(
    externalId: string,
    options?: { signal?: AbortSignal },
  ): Promise<WispaceExercisePrecreateResult> {
    return this.exerciseClient.precreateNextExercise(
      this.idHeader,
      externalId,
      options,
    );
  }
}
