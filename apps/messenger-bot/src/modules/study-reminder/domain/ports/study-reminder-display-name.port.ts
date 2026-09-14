export const STUDY_REMINDER_DISPLAY_NAME_PORT = Symbol(
  'STUDY_REMINDER_DISPLAY_NAME_PORT',
);

export interface StudyReminderDisplayNamePort {
  resolveDisplayName(params: {
    userId?: number;
    externalUserId?: string;
  }): Promise<string>;
  preloadDisplayNames(userIds: number[]): Promise<void>;
}
