import type { WriteToolBudgetPort } from './write-tool-budget';
import type { StageInput, StageResult } from '@wispace/reschedule-confirm';
import type {
  AdmissionMetrics,
  AgentMetricsPort,
  ContentClassifierPort,
  LlmExecutionPort,
} from '@wispace/llm-agent';
import type { PinnedFact } from './pinned-facts';
import type { WispaceCacheInvalidationPort } from './wispace-capability.ports';
import type { ClarificationStateStore } from '../clarification/clarification-state';

/**
 * Platform-neutral agent context — Discord sets `isServerChannel` +
 * `privateDataFetched`; Zalo never sets them (optional by design).
 */
export interface PlatformAgentToolContext {
  externalUserId: string;
  /** WISPACE userId if the platform account is linked; undefined otherwise. */
  userId?: number;
  /** Revision of the current external→WISPACE mapping used for approvals. */
  mappingVersion?: string;
  /** False when the authoritative mapping lookup failed or returned none. */
  identityVerified?: boolean;
  /** The learner's current message — used by side-effect tools to verify
   * explicit intent before executing (#163). */
  userText?: string;
  /** True when the message came from a Discord server channel (not a DM). */
  isServerChannel?: boolean;
  /**
   * Mutated to true by any tool that fetches personal data (schedule, scores,
   * goals). Discord's gateway uses this flag to route the reply to DM instead
   * of the server channel; Zalo ignores it.
   */
  privateDataFetched?: boolean;
  /**
   * Server-derived facts to deterministically merge into the final reply
   * (generic pinned-facts mechanism, #207 item 6). Tools push facts here —
   * the service appends any fact missing from the model's text.
   */
  pinnedFacts?: PinnedFact[];
  /**
   * Platform-specific quick replies / buttons collected by tools (Messenger
   * rich follow-ups). Optional — Discord/Zalo never fill it.
   */
  richFollowUps?: unknown[];
  /**
   * Platform-specific link context (Messenger ref token). Optional — Discord
   * and Zalo resolve links through their own account-link flows.
   */
  linkContext?: unknown;
  /** In-memory per-turn count of write-tool executions, keyed by tool name.
   *  Enforces the per-message cap (#626); never persisted. */
  writeToolCalls?: Map<string, number>;
  /** Tools whose daily budget unit was consumed this turn — refunded if the
   *  mutation did not ultimately succeed (#626). */
  writeToolDailyConsumed?: Set<string>;
}

export interface PlatformAgentReply {
  text: string;
  /** Mirrors PlatformAgentToolContext.privateDataFetched after agent run. */
  privateDataFetched: boolean;
  /** Tools may push platform-specific follow-ups (Messenger quick replies). */
  richFollowUps?: unknown[];
  /** True when the agent loop hit maxToolRounds without a final text. */
  exhausted?: boolean;
  /** E.g. "[Đã tra cứu: get_user_goals]" — appended to history for next turns. */
  toolSummary?: string;
  /** Canned clarification/recovery replies do not become long-term context. */
  skipHistory?: boolean;
  /** Stable inbound-event key used to prevent duplicate clarification sends. */
  deliveryKey?: string;
  /** Marks a reply as clarification lifecycle telemetry, not a normal answer. */
  clarification?: boolean;
  /** Redelivery already attempted this canned reply; do not send it again. */
  skipDelivery?: boolean;
}

export interface PlatformAgentInput {
  externalUserId: string;
  userId?: number;
  /** Mapping revision captured with the inbound event, if available. */
  mappingVersion?: string;
  userText: string;
  /** Platform message id — LLM usage correlation id. */
  correlationId?: string;
  isServerChannel?: boolean;
  /** Pre-loaded history — when absent the service loads it itself. */
  history?: readonly {
    role: 'user' | 'assistant' | 'tool_summary';
    content: string;
  }[];
  /** Platform-specific link context (Messenger ref token). */
  linkContext?: unknown;
  /**
   * Optional caller cancellation signal — aborts the whole agent loop,
   * in-flight LLM requests and tool calls immediately (e.g. platform
   * disconnect / shutdown). Undefined means no caller cancellation.
   */
  signal?: AbortSignal;
}

/** Per-platform agent options — prompt files are owned by each app. */
export interface PlatformAgentOptions {
  /** Stable platform namespace for clarification state (messenger/discord/zalo). */
  platform?: string;
  /** Required authoritative external-id mapping lookup performed before tools. */
  currentIdentityProvider: (
    externalUserId: string,
  ) => Promise<CurrentPlatformIdentity | undefined>;
  /** Optional state store seam; defaults to bounded memory/Redis selection. */
  clarificationStore?: ClarificationStateStore;
  promptDir: string;
  promptFile: string;
  /**
   * Appended to the base system prompt (e.g. Messenger's per-user display
   * name linkage note). Default: no suffix.
   */
  systemPromptSuffix?: (
    input: PlatformAgentInput,
  ) => Promise<string | undefined>;
  /** Called before the LLM loop (Messenger sets OTel span attributes). */
  onBeforeReply?: (input: PlatformAgentInput) => Promise<void>;
  /**
   * Called after a tool executed successfully, with the raw (unserialized)
   * result — e.g. to persist learner facts from server-derived tool results
   * (`@wispace/learner-profile`). Fire-and-forget: a rejection must never
   * break the agent loop.
   */
  onToolResult?: (params: {
    toolName: string;
    argsJson: string;
    result: unknown;
    context: PlatformAgentToolContext;
  }) => void | Promise<void>;
  /**
   * Messenger's fast "reschedule my default session" pre-check — returns a
   * ready reply without calling the LLM, or null to continue the normal loop.
   */
  tryFastReschedule?: (
    ctx: PlatformAgentToolContext,
    userText: string,
  ) => Promise<PlatformAgentReply | null>;
  /** Prometheus/OTel agent metrics (default: no-op). */
  metrics?: AgentMetricsPort;
  /** Bounded clarification lifecycle metrics; labels contain no user data. */
  clarificationOutcomeInc?: (outcome: string) => void;
  /**
   * LLM execution-control port (limiter/deadline/retry). Apps with a full
   * execution service (Messenger's `LlmExecutionService`) inject it here;
   * otherwise the service builds one from the shared `LLM_EXECUTION_*` env
   * contract. One documented execution-control path for free-form chat.
   */
  llmExecution?: LlmExecutionPort;
  /**
   * Bounded-admission telemetry for the default env execution port (#389).
   * Ignored when `llmExecution` is injected directly.
   */
  llmAdmissionMetrics?: AdmissionMetrics;
  /** 0 disables agent-level retry when the app's LLM execution already retries. */
  maxLlmRetries?: number;
  /** Per-tool execution timeout in ms (Messenger report tool needs 30s). */
  toolExecutionTimeoutMs?: number;
  /**
   * When true (default), the service appends the turn to chat history itself.
   * Callers that provide preloaded history own the append after delivery.
   */
  appendHistory?: boolean;
  /**
   * #649 — optional second-tier input classifier. Present only on bots that
   * wire it (Messenger during the shadow window). Gated at runtime by
   * `LLM_INPUT_CLASSIFIER_ENABLED`; enforcement by `LLM_INPUT_CLASSIFIER_ENFORCE`.
   */
  contentClassifier?: ContentClassifierPort;
}

/**
 * Stage-only view of the shared `RescheduleConfirmationService`.
 */
export interface RescheduleStagePort {
  stage(input: StageInput<string>): Promise<StageResult | { error: string }>;
}

/**
 * Tool-execution seam for the agent loop. The shared `PlatformAgentToolsService`
 * implements the Discord/Zalo tool set; platforms whose tools differ (Messenger:
 * LLM report, StudyDataPort-based calendar tools, real subscription upsert,
 * quick-reply follow-ups) provide their own app-owned executor implementing this
 * port — platform-specific execution stays explicit in app adapters instead of
 * conditional flags in the shared options.
 */
export interface PlatformToolExecutorPort {
  execute(
    toolName: string,
    argsJson: string,
    ctx: PlatformAgentToolContext,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface CurrentPlatformIdentity {
  userId: number;
  /** Changes whenever the platform mapping is relinked or updated. */
  mappingVersion: string;
}

/**
 * Per-platform tool options. Every platform-specific string/mechanism is
 * injected so the shared service preserves each app's behavior exactly.
 */
export interface PlatformAgentToolsOptions {
  /** Platform namespace used for bounded policy-denial telemetry. */
  platform?: string;
  /** Not-linked message (may embed platform link instructions). */
  getNotLinkedMessage: () => string;
  /**
   * External id sent to the Wispace API — Discord uses `ctx.externalUserId`;
   * Zalo uses the WISPACE `userId` (historical behavior, kept as-is).
   */
  wispaceExternalId: (ctx: PlatformAgentToolContext) => string;
  /** Success text for `register_exam_report_notifications`. */
  registerReportMessage: string;
  /** Required re-read of the authoritative mapping at tool execution time. */
  currentIdentityProvider: (
    externalUserId: string,
  ) => Promise<CurrentPlatformIdentity | undefined>;
  /** Bounded policy-denial metric; arguments and identities are never passed. */
  policyDeniedInc?: (toolName: string, reason: string) => void;
  /** Per-user write-tool budget (#626). Absent = enforcement disabled. */
  writeToolBudget?: WriteToolBudgetPort;
  /** tool name → per-message cap (#626). */
  writeToolPerMessageCaps?: Record<string, number>;
  /** Bounded denial metric (#626); no ids. reason is always 'per_message' at
   *  this call site — daily denials are emitted inside WriteToolBudgetCore. */
  writeToolBudgetDeniedInc?: (toolName: string, reason: 'per_message') => void;
  /**
   * WISPACE cache invalidation (#636): mutating tools drop the affected
   * per-user cache entries after a successful write so the next read
   * re-fetches. Optional — apps without a WISPACE read cache omit it.
   */
  cacheInvalidation?: WispaceCacheInvalidationPort;
  /**
   * Defense-in-depth fresh-mapping check (#397) for destructive tools
   * (reschedule_study_session). When present, the tool re-verifies the
   * current mapping before staging to prevent identity-hijack from a
   * stale queued snapshot.
   */
  freshMappingProvider?: (externalUserId: string) => Promise<
    | number
    | undefined
    | {
        state:
          | 'active'
          | 'temporarily-unknown'
          | 'confirmed-revoked'
          | 'locally-unlinked';
        userId?: number;
      }
  >;
  reschedule: {
    /** Discord validates newLocalDate/newTime; Zalo does not. */
    validateDateAndTime: boolean;
    messages: {
      calendarIdRequired: string;
      schedulingModeInvalid: string;
      newLocalDateInvalid: string;
      newTimeInvalid: string;
    };
    /** Sends the confirmation prompt (Discord: buttons; Zalo: text + reply hint). */
    confirmSender: (
      externalUserId: string,
      summary: string,
      confirmationToken?: string,
    ) => Promise<void>;
  };
}

/** Per-platform chat history options. */
export interface PlatformChatHistoryOptions {
  /** Env key prefix, e.g. `CHAT_HISTORY_` (Discord) or `ZALO_CHAT_HISTORY_`. */
  envPrefix: string;
  /** Redis key prefix, e.g. `chat-history:discord:`. */
  keyPrefix: string;
}

/** Per-platform chat queue options — all optional (Zalo uses none). */
export interface PlatformChatQueueOptions {
  /** Max chars for merged user text (Discord reads CHAT_MERGED_TEXT_MAX_CHARS). */
  mergedTextMaxChars?: number;
  /** Called on pipeline `before_agent` step (Discord typing indicator). */
  typingIndicator?: (externalUserId: string) => Promise<void>;
  /** When true, flush context carries `{ isServerChannel }` (Discord only). */
  propagateServerChannel?: boolean;
  /**
   * Fresh-mapping revalidation (#397): resolves the current WISPACE userId
   * for the given platform externalUserId before pipeline flush. When present,
   * the shared queue service compares the result against the buffered userId
   * and adopts the fresh value (or drops the batch when the mapping is gone).
   * Absent = no revalidation (legacy behavior, safe for platforms that manage
   * their own check upstream).
   */
  freshMappingProvider?: (externalUserId: string) => Promise<
    | number
    | undefined
    | {
        state:
          | 'active'
          | 'temporarily-unknown'
          | 'confirmed-revoked'
          | 'locally-unlinked';
        userId?: number;
      }
  >;
  /** Clears pending clarification when unlink/relink changes identity. */
  clarificationStateClearer?: (externalUserId: string) => Promise<void>;
  /** Re-opens a clarification only when its known outbound attempt failed. */
  clarificationDeliveryFailure?: (
    externalUserId: string,
    eventId?: string,
  ) => Promise<void>;
  /** Records clarification delivery failures without user data labels. */
  clarificationOutcomeInc?: (outcome: string) => void;
}
