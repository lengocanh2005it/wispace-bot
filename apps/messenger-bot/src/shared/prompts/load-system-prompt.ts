import { readFileSync } from 'fs';
import { join } from 'path';

const promptCache = new Map<string, string>();

export const SYSTEM_PROMPT_FILES = {
  studyReminder: 'study-reminder.system.txt',
  studentReport: 'student-report.system.txt',
} as const;

export type SystemPromptKey = keyof typeof SYSTEM_PROMPT_FILES;

export function loadSystemPrompt(key: SystemPromptKey): string {
  const fileName = SYSTEM_PROMPT_FILES[key];
  const cached = promptCache.get(fileName);

  if (cached) {
    return cached;
  }

  const content = readFileSync(join(__dirname, fileName), 'utf8').trim();

  promptCache.set(fileName, content);
  return content;
}
