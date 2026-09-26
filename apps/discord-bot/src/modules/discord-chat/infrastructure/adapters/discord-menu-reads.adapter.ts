import { Injectable } from '@nestjs/common';
import {
  WispaceCalendarService,
  WispaceGoalsService,
} from '@wispace/wispace-client/adapters';
import type { DiscordMenuReadsPort } from '../../application/ports/discord-menu-reads.port';

@Injectable()
export class DiscordMenuReadsAdapter implements DiscordMenuReadsPort {
  constructor(
    private readonly calendarService: WispaceCalendarService,
    private readonly goalsService: WispaceGoalsService,
  ) {}

  async getUpcomingSessions(discordUserId: string, limit: number) {
    return this.calendarService.getCalendarSessions(discordUserId, {
      timeRange: 'upcoming',
      limit,
    });
  }

  getGoals(discordUserId: string) {
    return this.goalsService.getUserGoals(discordUserId);
  }

  getTaskScoreAverages(discordUserId: string) {
    return this.goalsService.getTaskScoreAverages(discordUserId);
  }
}
