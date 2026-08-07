import type { LlmToolDefinition } from './provider/types';

export const AGENT_TOOL_NAMES = [
  'get_learning_progress_report',
  'get_user_goals',
  'get_upcoming_study_sessions',
  'list_study_calendar_entries',
  'reschedule_study_session',
  'preview_next_study_reminder',
  'register_exam_report_notifications',
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export const SCORE_TOOLS: ReadonlySet<AgentToolName> = new Set([
  'get_user_goals',
  'get_learning_progress_report',
]);

export const SCHEDULE_TOOLS: ReadonlySet<AgentToolName> = new Set([
  'list_study_calendar_entries',
  'get_upcoming_study_sessions',
  'preview_next_study_reminder',
]);

export function isAgentToolName(name: string): name is AgentToolName {
  return (AGENT_TOOL_NAMES as readonly string[]).includes(name);
}

export const AGENT_TOOLS: LlmToolDefinition[] = [
  {
    name: 'get_learning_progress_report',
    description:
      'Lấy báo cáo tiến độ học IELTS Writing đầy đủ: điểm task 1/2, mục tiêu, số bài đã làm, gợi ý cải thiện.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_user_goals',
    description: 'Lấy mục tiêu band và ngày thi IELTS của học viên từ WISPACE.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_upcoming_study_sessions',
    description:
      'Danh sách buổi học IELTS Writing sắp tới từ lịch UserCalendar của học viên. Dùng để hiển thị lịch. Nếu cần calendarId để đổi lịch, dùng list_study_calendar_entries thay thế.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Số buổi tối đa trả về (mặc định 5).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_study_calendar_entries',
    description:
      'Liệt kê lịch học UserCalendar (calendarId, scheduledTimeLabel). timeRange=upcoming (mặc định) cho lịch sắp tới và đổi lịch; past cho lịch đã qua; all cho cả hai. Dùng tool này (không dùng get_upcoming_study_sessions) khi đổi lịch.',
    parameters: {
      type: 'object',
      properties: {
        timeRange: {
          type: 'string',
          enum: ['upcoming', 'past', 'all'],
          description:
            'upcoming = sắp tới (mặc định); past = đã qua; all = cả hai.',
        },
        limit: {
          type: 'number',
          description: 'Số buổi tối đa (mặc định 10).',
        },
        pastDays: {
          type: 'number',
          description:
            'Với past/all: chỉ lấy buổi trong N ngày gần đây (mặc định 90).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'reschedule_study_session',
    description:
      'Luôn gọi list_study_calendar_entries trước để lấy calendarId. Sau đó chuẩn bị dời buổi học (gửi nút xác nhận cho học viên; chỉ thực hiện sau khi bấm Xác nhận). default_next_day_same_time = cùng giờ, +1 ngày so với buổi đang dời (buổi ngày mai → ngày kia). explicit khi học viên nêu rõ ngày/giờ mới.',
    parameters: {
      type: 'object',
      properties: {
        calendarId: {
          type: 'number',
          description: 'Id buổi học cần dời (từ list_study_calendar_entries).',
        },
        schedulingMode: {
          type: 'string',
          enum: ['default_next_day_same_time', 'explicit'],
          description:
            'default_next_day_same_time khi học viên không nói rõ giờ/ngày mới; explicit khi có yêu cầu cụ thể.',
        },
        newLocalDate: {
          type: 'string',
          description:
            'Ngày mới theo lịch VN, định dạng YYYY-MM-DD. Chỉ dùng khi schedulingMode=explicit.',
        },
        newTime: {
          type: 'string',
          description:
            'Giờ mới HH:mm (24h). Chỉ dùng khi schedulingMode=explicit.',
        },
      },
      required: ['calendarId', 'schedulingMode'],
      additionalProperties: false,
    },
  },
  {
    name: 'preview_next_study_reminder',
    description:
      'Chỉ dùng khi học viên TỰ yêu cầu xem trước nội dung tin nhắn nhắc. Không gọi sau khi xem lịch học.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'register_exam_report_notifications',
    description:
      'Đăng ký nhận báo cáo AI tự động qua Messenger khoảng 2–3 ngày trước ngày thi.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

export function readPositiveLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), 10);
}

export function readPastDays(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 90;
  return Math.min(Math.floor(parsed), 365);
}

export function readCalendarTimeRange(
  value: unknown,
): 'upcoming' | 'past' | 'all' | undefined {
  if (value === 'upcoming' || value === 'past' || value === 'all') return value;
  return undefined;
}

export function readPositiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

export function readSchedulingMode(
  value: unknown,
): 'default_next_day_same_time' | 'explicit' | undefined {
  if (value === 'default_next_day_same_time' || value === 'explicit')
    return value;
  return undefined;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function readValidatedDate(value: unknown): string | undefined {
  const str = readOptionalString(value);
  if (!str) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(str) ? str : undefined;
}

export function readValidatedTime(value: unknown): string | undefined {
  const str = readOptionalString(value);
  if (!str) return undefined;
  return /^\d{2}:\d{2}$/.test(str) ? str : undefined;
}
