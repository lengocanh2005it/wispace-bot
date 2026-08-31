import type {
  CalendarCapabilityPort,
  ExerciseCapabilityPort,
  GoalsCapabilityPort,
  WispaceCacheInvalidationPort,
  WispaceCalendarSessionView,
  WispaceExercisePrecreateResult,
  WispaceGoalsRecord,
  WispaceTaskScoreView,
} from '@wispace/chat-agent';
import {
  PrecreateExerciseApiClient,
  WispaceCalendarService,
  WispaceGoalsService,
  WispaceDataCache,
} from '@wispace/wispace-client';

/**
 * Wire the concrete wispace-client services to the chat-agent capability
 * ports (#425). The Discord identity header is baked here — no default
 * exists in the shared package. Reads go through the shared `WispaceDataCache`
 * (TTL policy + invalidation, #636); mutations invalidate through
 * `DiscordWispaceCacheInvalidationAdapter`.
 */

export class DiscordGoalsCapabilityAdapter implements GoalsCapabilityPort {
  constructor(
    private readonly goalsService: WispaceGoalsService,
    private readonly cache: WispaceDataCache,
  ) {}

  getUserGoals(
    externalId: string,
    options?: { signal?: AbortSignal },
  ): Promise<WispaceGoalsRecord> {
    return this.cache.getOrFetch('goals', externalId, undefined, () =>
      this.goalsService.getUserGoals(externalId, options),
    );
  }

  getTaskScoreAverages(
    externalId: string,
    options?: { signal?: AbortSignal },
  ): Promise<WispaceTaskScoreView[]> {
    return this.cache.getOrFetch('scores', externalId, undefined, () =>
      this.goalsService.getTaskScoreAverages(externalId, options),
    );
  }
}

export class DiscordCalendarCapabilityAdapter implements CalendarCapabilityPort {
  constructor(
    private readonly calendarService: WispaceCalendarService,
    private readonly cache: WispaceDataCache,
  ) {}

  getCalendarSessions(
    externalId: string,
    options?: {
      timeRange?: 'upcoming' | 'past' | 'all';
      pastDays?: number;
      limit?: number;
      userId?: number;
      signal?: AbortSignal;
    },
  ): Promise<WispaceCalendarSessionView[]> {
    const { signal: _signal, ...args } = options ?? {};
    return this.cache.getOrFetch('calendar', externalId, args, () =>
      this.calendarService.getCalendarSessions(externalId, options),
    );
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

export class DiscordWispaceCacheInvalidationAdapter implements WispaceCacheInvalidationPort {
  constructor(private readonly cache: WispaceDataCache) {}

  invalidateGoals(externalUserId: string): void {
    this.cache.invalidateUser(externalUserId, ['goals']);
  }

  invalidateCalendar(externalUserId: string): void {
    this.cache.invalidateUser(externalUserId, ['calendar']);
  }
}
