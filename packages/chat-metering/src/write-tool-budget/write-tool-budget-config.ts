import type { WriteToolBudgetSettings } from './write-tool-budget.types';

const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';
const DAILY_DEFAULTS = {
  reschedule_study_session: 8,
  precreate_next_exercise: 15,
} as const;
const PER_MESSAGE_DEFAULTS = {
  reschedule_study_session: 1,
  precreate_next_exercise: 3,
} as const;

function positiveIntOr(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function readWriteToolBudgetConfig(
  get: (key: string) => string | undefined,
): WriteToolBudgetSettings {
  const enabledRaw = get('CHAT_WRITE_TOOL_BUDGET_ENABLED')
    ?.trim()
    .toLowerCase();
  const enabled = enabledRaw
    ? !['false', '0', 'no'].includes(enabledRaw)
    : true;

  return {
    enabled,
    timezone: get('CHAT_USAGE_TIMEZONE')?.trim() || DEFAULT_TIMEZONE,
    dailyCaps: {
      reschedule_study_session: positiveIntOr(
        get('CHAT_WRITE_TOOL_DAILY_CAP_RESCHEDULE'),
        DAILY_DEFAULTS.reschedule_study_session,
      ),
      precreate_next_exercise: positiveIntOr(
        get('CHAT_WRITE_TOOL_DAILY_CAP_PRECREATE'),
        DAILY_DEFAULTS.precreate_next_exercise,
      ),
    },
    perMessageCaps: {
      reschedule_study_session: positiveIntOr(
        get('CHAT_WRITE_TOOL_PER_MESSAGE_CAP_RESCHEDULE'),
        PER_MESSAGE_DEFAULTS.reschedule_study_session,
      ),
      precreate_next_exercise: positiveIntOr(
        get('CHAT_WRITE_TOOL_PER_MESSAGE_CAP_PRECREATE'),
        PER_MESSAGE_DEFAULTS.precreate_next_exercise,
      ),
    },
    whitelist: new Set(
      (get('CHAT_RATE_LIMIT_WHITELIST_PSIDS') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  };
}
