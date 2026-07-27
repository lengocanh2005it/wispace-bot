export const DISCORD_REPORT_PORT = Symbol('DISCORD_REPORT_PORT');

export interface DiscordReportPort {
  generateReport(discordUserId: string): Promise<string>;
}
