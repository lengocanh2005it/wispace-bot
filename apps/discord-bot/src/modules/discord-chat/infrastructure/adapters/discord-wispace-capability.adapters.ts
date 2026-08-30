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
 * ports (#425). The Discord identity header is baked here — no default
 * exists in the shared package.
 */

export class DiscordGoalsCapabilityAdapter implements GoalsCapabilityPort {
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

export class DiscordCalendarCapabilityAdapter implements CalendarCapabilityPort {
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

export class DiscordExerciseCapabilityAdapter implements ExerciseCapabilityPort {
  constructor(
    private readonly exerciseClient: PrecreateExerciseApiClient,
    private readonly idHeader: 'x-discordid',
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
