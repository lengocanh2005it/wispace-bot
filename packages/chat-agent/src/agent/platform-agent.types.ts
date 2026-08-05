import type { ReportDeliveryPort } from '@wispace/scheduler-core';
import type { StageInput, StageResult } from '@wispace/reschedule-confirm';

/**
 * Platform-neutral agent context — Discord sets `isServerChannel` +
 * `privateDataFetched`; Zalo never sets them (optional by design).
 */
export interface PlatformAgentToolContext {
  externalUserId: string;
  /** WISPACE userId if the platform account is linked; undefined otherwise. */
  userId?: number;
  /** True when the message came from a Discord server channel (not a DM). */
  isServerChannel?: boolean;
  /**
   * Mutated to true by any tool that fetches personal data (schedule, scores,
   * goals). Discord's gateway uses this flag to route the reply to DM instead
   * of the server channel; Zalo ignores it.
   */
  privateDataFetched?: boolean;
}

export interface PlatformAgentReply {
  text: string;
  /** Mirrors PlatformAgentToolContext.privateDataFetched after agent run. */
  privateDataFetched: boolean;
}

export interface PlatformAgentInput {
  externalUserId: string;
  userId?: number;
  userText: string;
  /** Platform message id — LLM usage correlation id. */
  correlationId?: string;
  isServerChannel?: boolean;
}

/** Per-platform agent options — prompt files are owned by each app. */
export interface PlatformAgentOptions {
  promptDir: string;
  promptFile: string;
}

/** Stage-only view of the shared `RescheduleConfirmationService`. */
export interface RescheduleStagePort {
  stage(input: StageInput<string>): Promise<StageResult | { error: string }>;
}

/**
 * Per-platform tool options. Every platform-specific string/mechanism is
 * injected so the shared service preserves each app's behavior exactly.
 */
export interface PlatformAgentToolsOptions {
  /** Not-linked message (may embed platform link instructions). */
  getNotLinkedMessage: () => string;
  /**
   * External id sent to the Wispace API — Discord uses `ctx.externalUserId`;
   * Zalo uses the WISPACE `userId` (historical behavior, kept as-is).
   */
  wispaceExternalId: (ctx: PlatformAgentToolContext) => string;
  /** Success text for `register_exam_report_notifications`. */
  registerReportMessage: string;
  /** Discord injects its report delivery port; Zalo leaves it undefined. */
  reportDeliveryPort?: ReportDeliveryPort;
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
    confirmSender: (externalUserId: string, summary: string) => Promise<void>;
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
}
