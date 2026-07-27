import { ConfigService } from '@nestjs/config';
import type { GoalsDataPort } from '@wispace/scheduler-core';
import { parseExamDateToIso } from '@wispace/scheduler-core';

const WISPACE_API_USER_GOALS_URL = 'https://api.wispace.net/api/User/goals';
const WISPACE_API_TIMEOUT_MS = 10_000;

/**
 * Fetches user goals (exam date) from Wispace API for Discord users.
 */
export class DiscordGoalsDataAdapter implements GoalsDataPort {
  constructor(private readonly configService: ConfigService) {}

  async getUserGoals(externalUserId: string): Promise<{ examDate: string }> {
    const internalKey = this.configService.get<string>('WISPACE_INTERNAL_KEY');

    const response = await fetch(WISPACE_API_USER_GOALS_URL, {
      method: 'GET',
      headers: {
        'x-psid': externalUserId,
        'X-Internal-Key': internalKey ?? '',
      },
      signal: AbortSignal.timeout(WISPACE_API_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Wispace API user goals failed: HTTP ${response.status}`);
    }

    const data = (await response.json()) as { examDate?: string };
    if (!data.examDate) {
      throw new Error('Wispace API returned no examDate');
    }

    return { examDate: data.examDate };
  }

  parseExamDate(examDate: string): string {
    return parseExamDateToIso(examDate);
  }
}
