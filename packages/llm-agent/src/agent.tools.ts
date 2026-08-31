import type { LlmToolDefinition } from './provider/types';

export type ToolEffect =
  | 'read_only'
  | 'idempotent_side_effect'
  | 'confirmation_required';
export type ToolIdentityRequirement =
  | 'platform_identity'
  | 'linked_wispace_account';
export type ToolAuthorizationRequirement = 'linked_account';
export type ToolConfirmationRequirement =
  | 'none'
  | 'explicit_intent'
  | 'approval_token';
export type ToolIdempotencyStrategy =
  | 'none'
  | 'canonical_args'
  | 'provider_key'
  | 'confirmation_nonce';

export interface AgentToolCapability {
  effect: ToolEffect;
  identity: ToolIdentityRequirement;
  authorization: ToolAuthorizationRequirement;
  confirmation: ToolConfirmationRequirement;
  idempotency: ToolIdempotencyStrategy;
  /** Side-effect providers must supply their own durable idempotency key. */
  providerGuaranteeRequired: boolean;
}

export interface AgentToolDefinition extends LlmToolDefinition {
  capability: AgentToolCapability;
}

export const AGENT_TOOL_NAMES = [
  'get_learning_progress_report',
  'get_user_goals',
  'get_upcoming_study_sessions',
  'list_study_calendar_entries',
  'reschedule_study_session',
  'preview_next_study_reminder',
  'register_exam_report_notifications',
  'precreate_next_exercise',
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

const READ_ONLY_CAPABILITY: AgentToolCapability = {
  effect: 'read_only',
  identity: 'linked_wispace_account',
  authorization: 'linked_account',
  confirmation: 'none',
  idempotency: 'none',
  providerGuaranteeRequired: false,
};

const EXPLICIT_INTENT_CAPABILITY: AgentToolCapability = {
  effect: 'idempotent_side_effect',
  identity: 'linked_wispace_account',
  authorization: 'linked_account',
  confirmation: 'explicit_intent',
  idempotency: 'provider_key',
  providerGuaranteeRequired: true,
};

const RESCHEDULE_CAPABILITY: AgentToolCapability = {
  effect: 'confirmation_required',
  identity: 'linked_wispace_account',
  authorization: 'linked_account',
  confirmation: 'approval_token',
  idempotency: 'confirmation_nonce',
  providerGuaranteeRequired: false,
};

function exposeCapabilityVocabulary(
  tool: AgentToolDefinition,
): AgentToolDefinition {
  const {
    effect,
    identity,
    authorization,
    confirmation,
    idempotency,
    providerGuaranteeRequired,
  } = tool.capability;
  return {
    ...tool,
    description: `${tool.description} Policy vocabulary: effect=${effect}; identity=${identity}; authorization=${authorization}; confirmation=${confirmation}; idempotency=${idempotency}; provider_guarantee=${providerGuaranteeRequired}.`,
  };
}

export const AGENT_TOOLS: AgentToolDefinition[] = [
  {
    name: 'get_learning_progress_report',
    description:
      'Lấy báo cáo tiến độ học IELTS Writing đầy đủ: điểm task 1/2, mục tiêu, số bài đã làm, gợi ý cải thiện.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    capability: READ_ONLY_CAPABILITY,
  },
  {
    name: 'get_user_goals',
    description: 'Lấy mục tiêu band và ngày thi IELTS của học viên từ WISPACE.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    capability: READ_ONLY_CAPABILITY,
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
    capability: READ_ONLY_CAPABILITY,
  },
  {
    name: 'list_study_calendar_entries',
    description:
      'Liệt kê lịch học UserCalendar (calendarId, scheduledTimeLabel). timeRange=upcoming (mặc định) cho lịch sắp tới và đổi lịch; past cho lịch đã qua; all cho cả hai. Học viên hỏi lịch đã qua/history → timeRange=past hoặc all (mặc định lấy trong 90 ngày gần). Không từ chối khi học viên hỏi lịch quá khứ — dữ liệu lấy từ UserCalendar. Dùng tool này (không dùng get_upcoming_study_sessions) khi đổi lịch.',
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
    capability: READ_ONLY_CAPABILITY,
  },
  {
    name: 'reschedule_study_session',
    description:
      'Luôn gọi list_study_calendar_entries trước để lấy calendarId. Tool KHÔNG đổi lịch ngay — chỉ gửi yêu cầu xác nhận (nút hoặc keyword tùy platform); lịch chỉ thay đổi sau khi học viên xác nhận. Sau khi gọi: báo ngắn gọn đã gửi yêu cầu xác nhận; KHÔNG nói «đã dời» cho tới khi học viên xác nhận (kết quả không về trong cùng lượt tool). Chỉ đúng 1 buổi học và học viên muốn dời mà không nêu ngày/giờ mới → schedulingMode=default_next_day_same_time (cùng giờ, +1 ngày so với buổi đang dời; buổi ngày mai → ngày kia). Nhiều buổi học → hỏi buổi nào (vd "buổi ngày mai", "buổi 15/6") dựa trên scheduledTimeLabel trong danh sách. Học viên không nêu ngày/giờ mới rõ ràng → default_next_day_same_time; nêu rõ ngày/giờ → explicit kèm newLocalDate (YYYY-MM-DD) và/hoặc newTime (HH:mm).',
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
    capability: RESCHEDULE_CAPABILITY,
  },
  {
    name: 'preview_next_study_reminder',
    description:
      'Chỉ dùng khi học viên TỰ yêu cầu xem trước nội dung tin nhắn nhắc buổi học. Không gọi sau khi xem lịch học; không gọi để xem trước tin nhắn nhắc tự động (reminderNotice) khi tool lịch trả về — lúc đó chỉ nhắc lại đúng nội dung reminderNotice.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    capability: READ_ONLY_CAPABILITY,
  },
  {
    name: 'register_exam_report_notifications',
    description:
      'Chỉ gọi khi học viên yêu cầu rõ ràng đăng ký nhận báo cáo AI tự động, ví dụ "đăng ký nhận báo cáo" hoặc "muốn nhận báo cáo tự động". Không gọi khi học viên chỉ muốn xem báo cáo, nói báo cáo cho mình, nói đăng ký chung hoặc nhận thông tin.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    capability: EXPLICIT_INTENT_CAPABILITY,
  },
  {
    name: 'precreate_next_exercise',
    description:
      'Chỉ gọi khi học viên yêu cầu rõ ràng tạo hoặc nhận một bài tập mới tiếp theo trong roadmap (vd "tạo bài tập cho mình", "cho mình bài tập mới"). Không gọi nếu học viên chọn taskType, exerciseTopic, topic hoặc difficulty; tool này không nhận tham số lựa chọn hay id tài nguyên — endpoint tự lấy bài tiếp theo theo identity đã liên kết.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    capability: EXPLICIT_INTENT_CAPABILITY,
  },
].map(exposeCapabilityVocabulary);

const EFFECTS = new Set<ToolEffect>([
  'read_only',
  'idempotent_side_effect',
  'confirmation_required',
]);
const IDENTITIES = new Set<ToolIdentityRequirement>([
  'platform_identity',
  'linked_wispace_account',
]);
const AUTHORIZATIONS = new Set<ToolAuthorizationRequirement>([
  'linked_account',
]);
const CONFIRMATIONS = new Set<ToolConfirmationRequirement>([
  'none',
  'explicit_intent',
  'approval_token',
]);
const IDEMPOTENCY = new Set<ToolIdempotencyStrategy>([
  'none',
  'canonical_args',
  'provider_key',
  'confirmation_nonce',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Fails startup/CI when a tool is missing authorization metadata. */
export function validateAgentToolRegistry(
  tools: readonly AgentToolDefinition[],
): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (!AGENT_TOOL_NAMES.includes(tool.name as AgentToolName)) {
      throw new Error(`Unknown agent tool definition: ${tool.name}`);
    }
    if (names.has(tool.name)) {
      throw new Error(`Duplicate agent tool definition: ${tool.name}`);
    }
    names.add(tool.name);
    if (!isRecord(tool.capability)) {
      throw new Error(`Missing capability metadata for tool: ${tool.name}`);
    }
    if (!EFFECTS.has(tool.capability.effect)) {
      throw new Error(`Invalid effect metadata for tool: ${tool.name}`);
    }
    if (!IDENTITIES.has(tool.capability.identity)) {
      throw new Error(`Invalid identity metadata for tool: ${tool.name}`);
    }
    if (!AUTHORIZATIONS.has(tool.capability.authorization)) {
      throw new Error(`Invalid authorization metadata for tool: ${tool.name}`);
    }
    if (!CONFIRMATIONS.has(tool.capability.confirmation)) {
      throw new Error(`Invalid confirmation metadata for tool: ${tool.name}`);
    }
    if (!IDEMPOTENCY.has(tool.capability.idempotency)) {
      throw new Error(`Invalid idempotency metadata for tool: ${tool.name}`);
    }
    if (typeof tool.capability.providerGuaranteeRequired !== 'boolean') {
      throw new Error(
        `Invalid provider guarantee metadata for tool: ${tool.name}`,
      );
    }
    if (
      tool.capability.effect === 'idempotent_side_effect' &&
      (!tool.capability.providerGuaranteeRequired ||
        tool.capability.idempotency !== 'provider_key')
    ) {
      throw new Error(
        `Idempotent side effect requires a provider idempotency guarantee: ${tool.name}`,
      );
    }
    if (
      tool.capability.effect === 'confirmation_required' &&
      (tool.capability.confirmation !== 'approval_token' ||
        tool.capability.idempotency !== 'confirmation_nonce')
    ) {
      throw new Error(
        `Confirmation-required tool must bind an approval nonce: ${tool.name}`,
      );
    }
    if (!isRecord(tool.parameters) || tool.parameters.type !== 'object') {
      throw new Error(`Tool parameters must be an object: ${tool.name}`);
    }
  }
  if (names.size !== AGENT_TOOL_NAMES.length) {
    throw new Error('Agent tool registry is incomplete');
  }
}

validateAgentToolRegistry(AGENT_TOOLS);

export function getAgentToolDefinition(
  name: string,
): AgentToolDefinition | undefined {
  return AGENT_TOOLS.find((tool) => tool.name === name);
}

export type ToolArgumentValidationResult =
  | { ok: true; args: Record<string, unknown>; canonicalArgs: string }
  | { ok: false; error: string };

/** Stable JSON used for dedupe and approval binding. */
export function canonicalizeToolArguments(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (isRecord(input)) {
      return Object.keys(input)
        .sort()
        .reduce<Record<string, unknown>>((result, key) => {
          result[key] = normalize(input[key]);
          return result;
        }, {});
    }
    return input;
  };
  return JSON.stringify(normalize(value)) ?? 'null';
}

/** Strict, dependency-free subset of JSON Schema used by the tool registry. */
export function parseAndValidateToolArguments(
  toolName: string,
  argsJson: string,
  options: { allowMissingRequired?: boolean } = {},
): ToolArgumentValidationResult {
  const tool = getAgentToolDefinition(toolName);
  if (!tool) return { ok: false, error: 'Tool không được hỗ trợ' };

  let value: unknown = {};
  if (argsJson.trim()) {
    try {
      value = JSON.parse(argsJson);
    } catch {
      return { ok: false, error: 'Invalid tool arguments JSON' };
    }
  }
  if (!isRecord(value)) {
    return { ok: false, error: 'Tool arguments must be a JSON object' };
  }

  const parameters = tool.parameters;
  const properties = isRecord(parameters.properties)
    ? parameters.properties
    : {};
  if (parameters.additionalProperties === false) {
    const unknown = Object.keys(value).find(
      (key) => !Object.prototype.hasOwnProperty.call(properties, key),
    );
    if (unknown) {
      return { ok: false, error: `Unknown tool argument: ${unknown}` };
    }
  }

  for (const [key, propertyValue] of Object.entries(value)) {
    const property = properties[key];
    if (!isRecord(property)) continue;
    const type = property.type;
    const validType =
      type === 'string'
        ? typeof propertyValue === 'string'
        : type === 'number'
          ? typeof propertyValue === 'number' && Number.isFinite(propertyValue)
          : type === 'integer'
            ? typeof propertyValue === 'number' &&
              Number.isInteger(propertyValue)
            : type === 'boolean'
              ? typeof propertyValue === 'boolean'
              : true;
    if (!validType)
      return { ok: false, error: `Invalid tool argument: ${key}` };
    if (
      Array.isArray(property.enum) &&
      !property.enum.some((option) => Object.is(option, propertyValue))
    ) {
      return { ok: false, error: `Invalid tool argument: ${key}` };
    }
  }

  const required = Array.isArray(parameters.required)
    ? parameters.required.filter(
        (key): key is string => typeof key === 'string',
      )
    : [];
  const missing = required.find(
    (key) => !Object.prototype.hasOwnProperty.call(value, key),
  );
  if (missing && !options.allowMissingRequired) {
    return { ok: false, error: `Missing tool argument: ${missing}` };
  }

  return {
    ok: true,
    args: value,
    canonicalArgs: canonicalizeToolArguments(value),
  };
}

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
