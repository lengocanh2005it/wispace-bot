export interface DiscordMenuCalendarSession {
  topic: string;
  scheduledAt: Date;
}

export interface DiscordMenuGoals {
  targetScore: number;
  examDate: string;
}

export interface DiscordMenuTaskScore {
  task: string;
  avgTotalScore: number;
  totalTasks: number;
}

/**
 * WISPACE reads behind the menu buttons (#1088). The application service owns
 * the rendering; this port keeps `wispace-client` adapters out of the
 * application layer.
 */
export interface DiscordMenuReadsPort {
  getUpcomingSessions(
    discordUserId: string,
    limit: number,
  ): Promise<DiscordMenuCalendarSession[]>;

  getGoals(discordUserId: string): Promise<DiscordMenuGoals>;

  getTaskScoreAverages(discordUserId: string): Promise<DiscordMenuTaskScore[]>;
}

export const DISCORD_MENU_READS = Symbol('DISCORD_MENU_READS');
