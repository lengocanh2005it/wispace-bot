import type { GoalsDataPort } from '@wispace/scheduler-core';
import { parseExamDateToIso } from '@wispace/scheduler-core';
import { WispaceGoalsService } from '@discord/modules/wispace/application/services/wispace-goals.service';

/**
 * Fetches user goals (exam date) from Wispace API for Discord users.
 * Delegates to WispaceGoalsService so the x-discordid header and
 * WISPACE_API_USER_GOALS_URL config are used consistently.
 */
export class DiscordGoalsDataAdapter implements GoalsDataPort {
  constructor(private readonly goalsService: WispaceGoalsService) {}

  async getUserGoals(externalUserId: string): Promise<{ examDate: string }> {
    const record = await this.goalsService.getUserGoals(externalUserId);
    return { examDate: record.examDate };
  }

  parseExamDate(examDate: string): string {
    return parseExamDateToIso(examDate);
  }
}
