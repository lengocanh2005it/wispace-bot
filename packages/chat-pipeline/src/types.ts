/**
 * Narrow port interfaces for the chat flush pipeline.
 * Each platform maps its service methods to these ports.
 */

// ── Rate Limiter ────────────────────────────────────────────────────────────

export interface ReserveResult {
  allowed: boolean;
  usageDate?: string;
  reason?: ChatQuotaDenyReason;
  /** Quota limit that rejected the reserve (deny only). */
  limit?: number;
}

export interface RateLimiterPort {
  reserve(
    externalUserId: string,
    idempotencyKey: string,
    context?: Record<string, unknown>,
  ): Promise<ReserveResult>;
  refund(
    externalUserId: string,
    usageDate: string,
    idempotencyKey: string,
  ): Promise<void>;
  markDelivered(idempotencyKey: string): Promise<void>;
  markCompleted(idempotencyKey: string): Promise<void>;
}

// ── History ─────────────────────────────────────────────────────────────────

export interface HistoryPort {
  getHistory(externalUserId: string): Promise<readonly ChatHistoryMessage[]>;
  appendTurn(
    externalUserId: string,
    userText: string,
    assistantText: string,
    toolSummary?: string,
  ): Promise<void>;
}

import type { ChatHistoryMessage } from '@wispace/chat-history';
import type {
  ChatQuotaDenyReason,
  OutboundDeliveryOutcome,
} from '@wispace/contracts';
export type { ChatHistoryMessage };

/** Non-quota failure causes reported on a failed flush. */
export type ChatPipelineFailureReason =
  | 'rate_limited'
  | 'delivery_not_confirmed'
  | 'error';

// ── Agent ───────────────────────────────────────────────────────────────────

export interface AgentInput {
  externalUserId: string;
  userId?: number;
  userText: string;
  /** Ordered raw learner messages from the current debounced turn. */
  userTextParts?: readonly string[];
  history: readonly ChatHistoryMessage[];
  correlationId?: string;
  /** Platform-specific context (e.g. Discord server channel flag). */
  context?: Record<string, unknown>;
}

export interface AgentReply {
  text: string;
  toolSummary?: string;
  richFollowUps?: unknown[];
  privateDataFetched?: boolean;
  /** Canned recovery/clarification noise must not become long-term context. */
  skipHistory?: boolean;
  /** Stable key for provider-side/outbound clarification dedupe. */
  deliveryKey?: string;
  /** Marks a reply as clarification lifecycle telemetry. */
  clarification?: boolean;
  /** This is a redelivery of an already-attempted canned reply. */
  skipDelivery?: boolean;
}

export interface AgentPort {
  reply(input: AgentInput): Promise<AgentReply>;
}

// ── Outbound ────────────────────────────────────────────────────────────────

export interface SendResult {
  delivered: boolean;
  outcome?: OutboundDeliveryOutcome;
  /** At least one message unit was sent before a later failure. */
  partial?: boolean;
}

export interface OutboundPort {
  sendText(
    externalUserId: string,
    text: string,
    context?: Record<string, unknown>,
  ): Promise<SendResult>;
  /** Provider accepted neither a success nor a definitive failure verdict. */
  isAmbiguousDeliveryError?(error: unknown): boolean;
}

/**
 * Delivered: reply reached the learner. Denied: quota guard rejected the
 * batch before any turn. Duplicate: same idempotency key already in flight
 * or done. Failed: reserve won but the turn did not confirm delivery.
 */
export type ChatPipelineOutcome =
  | 'delivered'
  | 'denied'
  | 'duplicate'
  | 'failed';

export interface ChatPipelineResult {
  outcome: ChatPipelineOutcome;
  /** Deny reason on denied; failure cause on failed. */
  reason?: ChatQuotaDenyReason | ChatPipelineFailureReason;
  /** Quota limit that rejected the reserve (denied only). */
  limit?: number;
}

// ── Pipeline context (passed to hooks) ──────────────────────────────────────

export interface PipelineContext {
  externalUserId: string;
  userId?: number;
  mergedText: string;
  idempotencyKey?: string;
  usageDate?: string;
  reply?: AgentReply;
  error?: unknown;
  refundError?: unknown;
  quotaFinalizationError?: unknown;
  /** True when outbound delivered at least one unit but not all. */
  partialDelivery?: boolean;
  /** Do not automatically reopen a canned reply after an ambiguous send. */
  deliveryAmbiguous?: boolean;
}

// ── Hooks ───────────────────────────────────────────────────────────────────

export interface ChatPipelineHooks {
  /** Called before outbound.sendText. E.g. sender actions (typing_on, mark_seen). */
  onBeforeSend?: (ctx: PipelineContext) => Promise<void>;
  /** Called after main reply delivered successfully. E.g. rich follow-ups, quota hints. */
  onAfterSend?: (ctx: PipelineContext) => Promise<void>;
  /** Called on error before main reply delivered. E.g. fallback error message. */
  onError?: (ctx: PipelineContext) => Promise<void>;
  /** Called when the outbound limiter intentionally drops a reply. */
  onRateLimited?: (ctx: PipelineContext) => Promise<void>;
  /** Called when quota reserve rejects the batch; deny messaging flows through this hook. */
  onQuotaDenied?: (
    ctx: PipelineContext & { reason: ChatQuotaDenyReason; limit?: number },
  ) => Promise<void>;
  /** Called at each pipeline step for tracing/metrics. */
  onStep?: (step: string, ctx: PipelineContext) => Promise<void>;
}

// ── Pipeline config ─────────────────────────────────────────────────────────

export interface ChatPipelineConfig {
  /** Max characters for merged user text. Default: 4000. */
  mergedTextMaxChars?: number;
}

/**
 * Input supplied to a flush. `idempotencyKey` is required whenever quota
 * enforcement applies; the pipeline is the only layer that reserves.
 */
export interface ChatPipelineInput {
  externalUserId: string;
  userId?: number;
  texts: string[];
  /** Optional raw current messages when `texts` is already presentation-formatted. */
  userTextParts?: readonly string[];
  idempotencyKey?: string;
  context?: Record<string, unknown>;
}
