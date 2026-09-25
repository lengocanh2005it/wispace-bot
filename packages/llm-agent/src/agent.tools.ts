import { z } from 'zod';
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

export type AgentToolGroundingClaim =
  | 'goals'
  | 'progress'
  | 'schedule'
  | 'exercise';
export type AgentToolBudgetClassification = 'none' | 'write' | 'exempt';

interface AgentToolMetadataBase {
  observationFields: readonly string[];
  learnerLabel: string;
  groundingClaims: readonly AgentToolGroundingClaim[];
}

export type AgentToolMetadata =
  | (AgentToolMetadataBase & {
      budget: 'write';
      writeAction: string;
    })
  | (AgentToolMetadataBase & {
      budget: 'none' | 'exempt';
      writeAction?: string;
    });

/** The one tool schema (ADR 0010): provider JSON Schema, arg types, and runtime validation all derive from it. */
export type AgentToolArgsSchema = z.ZodObject<z.ZodRawShape>;

export interface AgentToolDefinition extends LlmToolDefinition {
  capability: AgentToolCapability;
  metadata: AgentToolMetadata;
  args: AgentToolArgsSchema;
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

const noArgs = z.object({}).strict();

const MAX_UPCOMING_LIMIT = 10;
const MAX_PAST_DAYS = 365;

function boundedPositiveInteger(max: number, description: string) {
  return z.preprocess(
    (value) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? Math.min(value, max)
        : value,
    z.int().min(1).max(max).describe(description).optional(),
  );
}

const getUpcomingStudySessionsArgs = z
  .object({
    limit: boundedPositiveInteger(
      MAX_UPCOMING_LIMIT,
      'Số buổi tối đa trả về (mặc định 5).',
    ),
  })
  .strict();

const listStudyCalendarEntriesArgs = z
  .object({
    timeRange: z
      .enum(['upcoming', 'past', 'all'])
      .describe('upcoming = sắp tới (mặc định); past = đã qua; all = cả hai.')
      .optional(),
    limit: boundedPositiveInteger(
      MAX_UPCOMING_LIMIT,
      'Số buổi tối đa (mặc định 10).',
    ),
    pastDays: boundedPositiveInteger(
      MAX_PAST_DAYS,
      'Với past/all: chỉ lấy buổi trong N ngày gần đây (mặc định 90).',
    ),
  })
  .strict();

const rescheduleStudySessionArgs = z
  .object({
    calendarId: z
      .int()
      .min(1)
      .describe('Id buổi học cần dời (từ list_study_calendar_entries).'),
    schedulingMode: z
      .enum(['default_next_day_same_time', 'explicit'])
      .describe(
        'default_next_day_same_time khi học viên không nói rõ giờ/ngày mới; explicit khi có yêu cầu cụ thể.',
      ),
    newLocalDate: z
      .string()
      .describe(
        'Ngày mới theo lịch VN, định dạng YYYY-MM-DD. Chỉ dùng khi schedulingMode=explicit.',
      )
      .optional(),
    newTime: z
      .string()
      .describe('Giờ mới HH:mm (24h). Chỉ dùng khi schedulingMode=explicit.')
      .optional(),
  })
  .strict();

export type GetUpcomingStudySessionsArgs = z.infer<
  typeof getUpcomingStudySessionsArgs
>;
export type ListStudyCalendarEntriesArgs = z.infer<
  typeof listStudyCalendarEntriesArgs
>;
export type RescheduleStudySessionArgs = z.infer<
  typeof rescheduleStudySessionArgs
>;

export type ToolResultCompleteness = 'incomplete' | 'unknown';

export interface BoundedToolResultMetadata {
  requestedLimit?: number;
  effectiveLimit: number;
  requestedPastDays?: number;
  effectivePastDays?: number;
  capped: boolean;
  completeness: ToolResultCompleteness;
}

export function buildBoundedToolResultMetadata(input: {
  requestedLimit?: number;
  effectiveLimit: number;
  requestedPastDays?: number;
  effectivePastDays?: number;
}): BoundedToolResultMetadata {
  const capped =
    (input.requestedLimit !== undefined &&
      input.requestedLimit > input.effectiveLimit) ||
    (input.requestedPastDays !== undefined &&
      input.effectivePastDays !== undefined &&
      input.requestedPastDays > input.effectivePastDays);

  return {
    ...(input.requestedLimit === undefined
      ? {}
      : { requestedLimit: input.requestedLimit }),
    effectiveLimit: input.effectiveLimit,
    ...(input.requestedPastDays === undefined
      ? {}
      : { requestedPastDays: input.requestedPastDays }),
    ...(input.effectivePastDays === undefined
      ? {}
      : { effectivePastDays: input.effectivePastDays }),
    capped,
    completeness: capped ? 'incomplete' : 'unknown',
  };
}

export type CalendarTimeRange = 'upcoming' | 'past' | 'all';

export interface BoundedToolDisclosure {
  timeRange?: CalendarTimeRange;
  limit: number;
  pastDays?: number;
  requestedLimit?: number;
  requestedPastDays?: number;
  count?: number;
  capped: boolean;
  completeness: ToolResultCompleteness;
}

const boundedToolDisclosureSchema = z
  .object({
    timeRange: z.enum(['upcoming', 'past', 'all']).optional(),
    requestedLimit: z.int().min(1).optional(),
    effectiveLimit: z.int().min(1),
    requestedPastDays: z.int().min(1).optional(),
    effectivePastDays: z.int().min(1).optional(),
    count: z.int().min(0).optional(),
    capped: z.boolean(),
    completeness: z.enum(['incomplete', 'unknown']),
  })
  .superRefine((value, ctx) => {
    if (
      (value.capped && value.completeness !== 'incomplete') ||
      (!value.capped && value.completeness !== 'unknown')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid bounded result completeness',
      });
    }
  });

function sameBoundedToolScope(
  current: BoundedToolDisclosure,
  next: BoundedToolDisclosure,
): boolean {
  return (
    current.timeRange === next.timeRange &&
    current.limit === next.limit &&
    current.pastDays === next.pastDays &&
    current.requestedLimit === next.requestedLimit &&
    current.requestedPastDays === next.requestedPastDays
  );
}

export function mergeBoundedToolDisclosures(
  current: BoundedToolDisclosure | undefined,
  next: BoundedToolDisclosure,
): BoundedToolDisclosure {
  if (!current) return next;
  if (!sameBoundedToolScope(current, next)) {
    return current.capped ? current : next;
  }
  if (current.capped !== next.capped) {
    if (!current.capped) return next;
    return {
      ...(current.timeRange === undefined
        ? {}
        : { timeRange: current.timeRange }),
      limit: current.limit,
      ...(current.pastDays === undefined ? {} : { pastDays: current.pastDays }),
      ...(current.requestedLimit === undefined
        ? {}
        : { requestedLimit: current.requestedLimit }),
      ...(current.requestedPastDays === undefined
        ? {}
        : { requestedPastDays: current.requestedPastDays }),
      capped: true,
      completeness: 'incomplete',
    };
  }
  if (!current.capped) return next;
  return {
    ...(current.timeRange === undefined
      ? {}
      : { timeRange: current.timeRange }),
    limit: current.limit,
    ...(current.pastDays === undefined ? {} : { pastDays: current.pastDays }),
    ...(current.requestedLimit === undefined
      ? {}
      : { requestedLimit: current.requestedLimit }),
    ...(current.requestedPastDays === undefined
      ? {}
      : { requestedPastDays: current.requestedPastDays }),
    ...(current.count === next.count && current.count !== undefined
      ? { count: current.count }
      : {}),
    capped: true,
    completeness: 'incomplete',
  };
}

export function readBoundedToolDisclosure(
  value: unknown,
): BoundedToolDisclosure | undefined {
  const parsed = boundedToolDisclosureSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const {
    timeRange,
    requestedLimit,
    effectiveLimit,
    requestedPastDays,
    effectivePastDays,
    count,
    capped,
    completeness,
  } = parsed.data;
  return {
    ...(timeRange === undefined ? {} : { timeRange }),
    limit: effectiveLimit,
    ...(effectivePastDays === undefined ? {} : { pastDays: effectivePastDays }),
    ...(requestedLimit === undefined ? {} : { requestedLimit }),
    ...(requestedPastDays === undefined ? {} : { requestedPastDays }),
    ...(count === undefined ? {} : { count }),
    capped,
    completeness,
  };
}

export const COMMON_TOOL_OBSERVATION_FIELDS = [
  'available',
  'blocked',
  'error',
  'message',
  'reason',
] as const;

function toProviderSchema(args: AgentToolArgsSchema): Record<string, unknown> {
  const { $schema: _schema, ...parameters } = z.toJSONSchema(args);
  return parameters as Record<string, unknown>;
}

const agentToolSpecs = [
  {
    name: 'get_learning_progress_report',
    description:
      'Lấy báo cáo tiến độ học IELTS Writing đầy đủ: điểm task 1/2, mục tiêu, số bài đã làm, gợi ý cải thiện.',
    args: noArgs,
    capability: READ_ONLY_CAPABILITY,
    metadata: {
      observationFields: ['report', ...COMMON_TOOL_OBSERVATION_FIELDS],
      learnerLabel: 'báo cáo tiến độ',
      groundingClaims: ['goals', 'progress'],
      budget: 'none',
    },
  },
  {
    name: 'get_user_goals',
    description: 'Lấy mục tiêu band và ngày thi IELTS của học viên từ WISPACE.',
    args: noArgs,
    capability: READ_ONLY_CAPABILITY,
    metadata: {
      observationFields: [
        'targetScore',
        'examDate',
        ...COMMON_TOOL_OBSERVATION_FIELDS,
      ],
      learnerLabel: 'mục tiêu band và ngày thi',
      groundingClaims: ['goals'],
      budget: 'none',
    },
  },
  {
    name: 'get_upcoming_study_sessions',
    description:
      'Danh sách buổi học IELTS Writing sắp tới từ lịch UserCalendar của học viên. Dùng để hiển thị lịch. Nếu cần calendarId để đổi lịch, dùng list_study_calendar_entries thay thế.',
    args: getUpcomingStudySessionsArgs,
    capability: READ_ONLY_CAPABILITY,
    metadata: {
      observationFields: [
        'timeRange',
        'count',
        'requestedLimit',
        'effectiveLimit',
        'requestedPastDays',
        'effectivePastDays',
        'capped',
        'completeness',
        'sessions',
        'reminderNotice',
        ...COMMON_TOOL_OBSERVATION_FIELDS,
      ],
      learnerLabel: 'lịch học sắp tới',
      groundingClaims: ['schedule'],
      budget: 'none',
    },
  },
  {
    name: 'list_study_calendar_entries',
    description:
      'Liệt kê lịch học UserCalendar (calendarId, scheduledTimeLabel). timeRange=upcoming (mặc định) cho lịch sắp tới và đổi lịch; past cho lịch đã qua; all cho cả hai. Học viên hỏi lịch đã qua/history → timeRange=past hoặc all (mặc định lấy trong 90 ngày gần). Không từ chối khi học viên hỏi lịch quá khứ — dữ liệu lấy từ UserCalendar. Dùng tool này (không dùng get_upcoming_study_sessions) khi đổi lịch.',
    args: listStudyCalendarEntriesArgs,
    capability: READ_ONLY_CAPABILITY,
    metadata: {
      observationFields: [
        'timeRange',
        'count',
        'requestedLimit',
        'effectiveLimit',
        'requestedPastDays',
        'effectivePastDays',
        'capped',
        'completeness',
        'entries',
        'reminderNotice',
        ...COMMON_TOOL_OBSERVATION_FIELDS,
      ],
      learnerLabel: 'lịch học',
      groundingClaims: ['schedule'],
      budget: 'none',
    },
  },
  {
    name: 'reschedule_study_session',
    description:
      'Luôn gọi list_study_calendar_entries trước để lấy calendarId. Tool KHÔNG đổi lịch ngay — chỉ gửi yêu cầu xác nhận bằng nút trên Messenger/Discord hoặc mã token trên Zalo; lịch chỉ thay đổi sau khi học viên xác nhận đúng cách. Không coi các câu đồng ý chung như "ok", "yes", "confirm", "đồng ý" là phê duyệt và không gọi lại tool để xác nhận. Sau khi gọi: báo ngắn gọn đã gửi yêu cầu xác nhận; KHÔNG nói «đã dời» cho tới khi học viên xác nhận (kết quả không về trong cùng lượt tool). Chỉ đúng 1 buổi học và học viên muốn dời mà không nêu ngày/giờ mới → schedulingMode=default_next_day_same_time (cùng giờ, +1 ngày so với buổi đang dời; buổi ngày mai → ngày kia). Nhiều buổi học → hỏi buổi nào (vd "buổi ngày mai", "buổi 15/6") dựa trên scheduledTimeLabel trong danh sách. Học viên không nêu ngày/giờ mới rõ ràng → default_next_day_same_time; nêu rõ ngày/giờ → explicit kèm newLocalDate (YYYY-MM-DD) và/hoặc newTime (HH:mm).',
    args: rescheduleStudySessionArgs,
    capability: RESCHEDULE_CAPABILITY,
    metadata: {
      observationFields: [
        'pendingConfirmation',
        'rescheduled',
        'sessionLabel',
        'summary',
        ...COMMON_TOOL_OBSERVATION_FIELDS,
      ],
      learnerLabel: 'thông tin đổi lịch',
      groundingClaims: [],
      budget: 'write',
      writeAction: 'đổi lịch học',
    },
  },
  {
    name: 'preview_next_study_reminder',
    description:
      'Chỉ dùng khi học viên TỰ yêu cầu xem trước nội dung tin nhắn nhắc buổi học. Không gọi sau khi xem lịch học; không gọi để xem trước tin nhắn nhắc tự động (reminderNotice) khi tool lịch trả về — lúc đó chỉ nhắc lại đúng nội dung reminderNotice.',
    args: noArgs,
    capability: READ_ONLY_CAPABILITY,
    metadata: {
      observationFields: [
        'hasSession',
        'scheduledTimeLabel',
        'reminder',
        'message',
        'session',
        ...COMMON_TOOL_OBSERVATION_FIELDS,
      ],
      learnerLabel: 'tin nhắn nhắc buổi học',
      groundingClaims: ['schedule'],
      budget: 'none',
    },
  },
  {
    name: 'register_exam_report_notifications',
    description:
      'Chỉ gọi khi học viên yêu cầu rõ ràng đăng ký nhận báo cáo AI tự động, ví dụ "đăng ký nhận báo cáo" hoặc "muốn nhận báo cáo tự động". Không gọi khi học viên chỉ muốn xem báo cáo, nói báo cáo cho mình, nói đăng ký chung hoặc nhận thông tin.',
    args: noArgs,
    capability: EXPLICIT_INTENT_CAPABILITY,
    metadata: {
      observationFields: [
        'registered',
        'alreadyActive',
        'automatic',
        'blocked',
        ...COMMON_TOOL_OBSERVATION_FIELDS,
      ],
      learnerLabel: 'đăng ký nhận báo cáo',
      groundingClaims: [],
      budget: 'exempt',
    },
  },
  {
    name: 'precreate_next_exercise',
    description:
      'Chỉ gọi khi học viên yêu cầu rõ ràng tạo hoặc nhận một bài tập mới tiếp theo trong roadmap (vd "tạo bài tập cho mình", "cho mình bài tập mới"). Không gọi nếu học viên chọn taskType, exerciseTopic, topic hoặc difficulty; tool này không nhận tham số lựa chọn hay id tài nguyên — endpoint tự lấy bài tiếp theo theo identity đã liên kết.',
    args: noArgs,
    capability: EXPLICIT_INTENT_CAPABILITY,
    metadata: {
      observationFields: [
        'exerciseUrl',
        'url',
        'status',
        'created',
        'existing',
        'messageHint',
        ...COMMON_TOOL_OBSERVATION_FIELDS,
      ],
      learnerLabel: 'thông tin bài tập mới',
      groundingClaims: ['exercise'],
      budget: 'write',
      writeAction: 'tạo bài tập mới',
    },
  },
] as const satisfies readonly Omit<AgentToolDefinition, 'parameters'>[];

type AgentToolSpec = (typeof agentToolSpecs)[number];
export type AgentToolName = AgentToolSpec['name'];
export type AgentToolMap<Value> = Record<AgentToolName, Value>;
type SelectAgentToolName<
  Spec extends {
    name: string;
    metadata: { budget: AgentToolBudgetClassification };
  },
  Budget extends AgentToolBudgetClassification,
> = Spec extends { metadata: { budget: Budget } } ? Spec['name'] : never;
export type AgentToolNameByBudget<
  Budget extends AgentToolBudgetClassification,
> = SelectAgentToolName<AgentToolSpec, Budget>;

export const AGENT_TOOL_NAMES: readonly AgentToolName[] = agentToolSpecs.map(
  ({ name }) => name,
);

export function isAgentToolName(name: string): name is AgentToolName {
  return (AGENT_TOOL_NAMES as readonly string[]).includes(name);
}

function hasGroundingClaim(
  name: AgentToolName,
  claim: AgentToolGroundingClaim,
): boolean {
  const spec = agentToolSpecs.find((candidate) => candidate.name === name);
  return (
    spec?.metadata.groundingClaims.some((candidate) => candidate === claim) ??
    false
  );
}

export function getAgentToolNamesByGroundingClaim(
  claim: AgentToolGroundingClaim,
): ReadonlySet<AgentToolName> {
  return new Set(
    AGENT_TOOL_NAMES.filter((name) => hasGroundingClaim(name, claim)),
  );
}

export const SCORE_TOOLS = getAgentToolNamesByGroundingClaim('goals');

export const SCHEDULE_TOOLS = getAgentToolNamesByGroundingClaim('schedule');

export const AGENT_TOOLS: AgentToolDefinition[] = agentToolSpecs
  .map((spec) => ({ ...spec, parameters: toProviderSchema(spec.args) }))
  .map(exposeCapabilityVocabulary);

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
const GROUNDING_CLAIMS = new Set<AgentToolGroundingClaim>([
  'goals',
  'progress',
  'schedule',
  'exercise',
]);
const BUDGET_CLASSIFICATIONS = new Set<AgentToolBudgetClassification>([
  'none',
  'write',
  'exempt',
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
    if (!isRecord(tool.metadata)) {
      throw new Error(`Missing tool metadata for tool: ${tool.name}`);
    }
    if (
      !Array.isArray(tool.metadata.observationFields) ||
      tool.metadata.observationFields.some((field) => typeof field !== 'string')
    ) {
      throw new Error(`Invalid observation metadata for tool: ${tool.name}`);
    }
    if (
      typeof tool.metadata.learnerLabel !== 'string' ||
      !tool.metadata.learnerLabel.trim()
    ) {
      throw new Error(`Invalid learner label metadata for tool: ${tool.name}`);
    }
    if (
      !Array.isArray(tool.metadata.groundingClaims) ||
      tool.metadata.groundingClaims.some(
        (claim) =>
          typeof claim !== 'string' ||
          !GROUNDING_CLAIMS.has(claim as AgentToolGroundingClaim),
      )
    ) {
      throw new Error(`Invalid grounding metadata for tool: ${tool.name}`);
    }
    if (
      !BUDGET_CLASSIFICATIONS.has(
        tool.metadata.budget as AgentToolBudgetClassification,
      )
    ) {
      throw new Error(`Invalid budget metadata for tool: ${tool.name}`);
    }
    if (
      tool.metadata.budget === 'write' &&
      (typeof tool.metadata.writeAction !== 'string' ||
        !tool.metadata.writeAction.trim())
    ) {
      throw new Error(`Missing write action metadata for tool: ${tool.name}`);
    }
    if (
      tool.metadata.writeAction !== undefined &&
      (typeof tool.metadata.writeAction !== 'string' ||
        !tool.metadata.writeAction.trim())
    ) {
      throw new Error(`Invalid write action metadata for tool: ${tool.name}`);
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

export function deriveAgentToolMap<Value>(
  select: (tool: AgentToolDefinition) => Value,
): AgentToolMap<Value> {
  const result = {} as AgentToolMap<Value>;
  for (const name of AGENT_TOOL_NAMES) {
    const tool = getAgentToolDefinition(name);
    if (!tool) {
      throw new Error(`Missing agent tool definition: ${name}`);
    }
    result[name] = select(tool);
  }
  return result;
}

export type ToolArgumentValidationResult =
  | {
      ok: true;
      args: Record<string, unknown>;
      requestedArgs?: Record<string, unknown>;
      canonicalArgs: string;
    }
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

/** Validates tool arguments through the tool's zod schema (ADR 0010). */
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

  // allowMissingRequired skips only the required-presence check: unknown
  // keys, types, and enums stay enforced — matching the partial schema.
  const schema = options.allowMissingRequired ? tool.args.partial() : tool.args;
  const result = schema.safeParse(value);
  if (result.success) {
    const args = result.data as Record<string, unknown>;
    const canonicalArgs = canonicalizeToolArguments(value);
    const normalizedCanonicalArgs = canonicalizeToolArguments(args);
    return {
      ok: true,
      args,
      ...(normalizedCanonicalArgs === canonicalArgs
        ? {}
        : { requestedArgs: value }),
      canonicalArgs,
    };
  }
  return {
    ok: false,
    error: toolArgumentsErrorMessage(tool.args, value, result.error.issues),
  };
}

/**
 * Maps zod issues onto the pre-migration error strings, keeping the old
 * precedence: first unknown key, then first invalid present key (both in
 * input key order), then first missing required key (in schema order).
 */
function toolArgumentsErrorMessage(
  schema: AgentToolArgsSchema,
  value: Record<string, unknown>,
  issues: z.ZodIssue[],
): string {
  const unknownKeys = new Set<string>();
  const invalidKeys = new Set<string>();
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) unknownKeys.add(key);
      continue;
    }
    const [key] = issue.path;
    if (typeof key !== 'string') continue;
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      invalidKeys.add(key);
    }
  }
  const inputKeys = Object.keys(value);
  const unknown = inputKeys.find((key) => unknownKeys.has(key));
  if (unknown) return `Unknown tool argument: ${unknown}`;
  const invalid = inputKeys.find((key) => invalidKeys.has(key));
  if (invalid) return `Invalid tool argument: ${invalid}`;
  const shape = schema.shape;
  const missing = Object.keys(shape)
    .filter((key) => !(shape[key] as z.ZodType).isOptional())
    .find((key) => !invalidKeys.has(key) && !hasArgValue(value, key));
  return missing
    ? `Missing tool argument: ${missing}`
    : 'Invalid tool arguments';
}

function hasArgValue(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertPositiveInteger(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Invalid tool argument: ${name}`);
  }
}

export function readPositiveLimit(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  assertPositiveInteger(value, 'limit');
  return Math.min(value, MAX_UPCOMING_LIMIT);
}

export function readPastDays(value: unknown): number {
  if (value === undefined) return 90;
  assertPositiveInteger(value, 'pastDays');
  return Math.min(value, MAX_PAST_DAYS);
}

export function readPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  assertPositiveInteger(value, 'calendarId');
  return value;
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
