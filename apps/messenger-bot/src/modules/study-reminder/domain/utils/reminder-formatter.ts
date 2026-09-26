import { FALLBACK_DISPLAY_NAME } from '@wispace/bot-common/messages';
import {
  parseJsonObject,
  readRequiredStringField,
} from '@wispace/llm-agent/core';
import { sanitizeMessengerText } from '@messenger/shared/utils/messenger-text.utils';
import {
  type StudyReminderLlmInput,
  type StudyReminderLlmOutput,
  type StudyReminderLlmProse,
} from '../entities/study-schedule.types';

interface RequiredStringArrayOptions {
  minItems?: number;
  maxItems?: number;
  maxCharsPerItem?: number;
}

function readRequiredStringArrayField(
  value: Record<string, unknown>,
  key: string,
  options?: RequiredStringArrayOptions,
): string[] {
  const raw = value[key];
  if (!Array.isArray(raw)) {
    throw new Error(`LLM JSON output missing string array field: ${key}`);
  }

  const maxItems = options?.maxItems ?? 8;
  const items = raw
    .slice(0, maxItems)
    .map((entry) =>
      typeof entry === 'string'
        ? sanitizeMessengerText(entry).replace(/\s+/g, ' ').trim()
        : '',
    )
    .filter(Boolean)
    .map((entry) => {
      const maxChars = options?.maxCharsPerItem ?? 180;
      return entry.length > maxChars
        ? `${entry.slice(0, maxChars).trim()}...`
        : entry;
    });

  if (items.length < (options?.minItems ?? 1)) {
    throw new Error(`LLM JSON output has too few items in field: ${key}`);
  }

  return items;
}

export interface ReminderParseResult {
  prose: StudyReminderLlmProse;
  /**
   * The `scheduledTime` value the model emitted, if any — kept only for
   * mismatch diagnostics. It is never rendered; the server label wins.
   */
  modelScheduledTime?: string;
}

export function parseReminderOutput(content: string): ReminderParseResult {
  const parsed = parseJsonObject(content);
  const prose: StudyReminderLlmProse = {
    greeting: readRequiredStringField(parsed, 'greeting', {
      maxChars: 120,
      sanitize: sanitizeMessengerText,
    }),
    intro: readRequiredStringField(parsed, 'intro', {
      maxChars: 240,
      sanitize: sanitizeMessengerText,
    }),
    tasks: readRequiredStringArrayField(parsed, 'tasks', {
      minItems: 3,
      maxItems: 4,
      maxCharsPerItem: 180,
    }),
    motivation: readRequiredStringField(parsed, 'motivation', {
      maxChars: 500,
      sanitize: sanitizeMessengerText,
    }),
    signoff: readRequiredStringField(parsed, 'signoff', {
      maxChars: 120,
      sanitize: sanitizeMessengerText,
    }),
  };
  const rawTime = parsed['scheduledTime'];
  return {
    prose,
    modelScheduledTime:
      typeof rawTime === 'string' && rawTime.trim()
        ? rawTime.trim()
        : undefined,
  };
}

/**
 * Binds LLM prose to the trusted server-derived time label. The model value
 * is never accepted — even on exact equality we render the server label
 * (issue #123).
 */
export function buildReminderOutput(
  prose: StudyReminderLlmProse,
  scheduledTimeLabel: string,
): StudyReminderLlmOutput {
  return { ...prose, scheduledTime: scheduledTimeLabel };
}

export function buildFallbackReminder(
  input: StudyReminderLlmInput,
): StudyReminderLlmOutput {
  const tasks = [
    'Ôn lại các bài essay gần đây và feedback',
    `Luyện viết theo chủ đề ${input.topic}`,
    'Tập trung vào điểm cần cải thiện',
  ];

  if (input.targetScore) {
    tasks.push(`Theo dõi tiến độ hướng band mục tiêu ${input.targetScore}`);
  }

  return {
    greeting:
      input.displayName.trim() === FALLBACK_DISPLAY_NAME
        ? 'Chào bạn nha,'
        : `Chào ${input.displayName},`,
    intro: 'mình nhắc bạn về buổi luyện IELTS Writing sắp tới nhé.',
    scheduledTime: input.scheduledTimeLabel,
    tasks,
    motivation:
      'Kiên trì luyện tập mỗi ngày sẽ giúp bạn tiến gần hơn tới mục tiêu IELTS. Chỉ cần một buổi ngắn cũng tạo khác biệt lớn!',
    signoff: 'Cố lên nhé! 💪',
  };
}

export function formatReminder(output: StudyReminderLlmOutput): string {
  const taskLines = output.tasks.map((task) => `• ${task}`).join('\n');
  const opening = [output.greeting, output.intro]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');

  return [
    opening,
    '',
    `📅 ${output.scheduledTime}`,
    '',
    'Gợi ý trước giờ học:',
    taskLines,
    '',
    output.motivation,
    '',
    output.signoff,
  ].join('\n');
}
