/**
 * Narrow port interfaces for the chat flush pipeline.
 * Each platform maps its service methods to these ports.
 */

// ── Rate Limiter ────────────────────────────────────────────────────────────

/**
 * A deny always carries the limit that rejected it, so deny copy never has to
 * invent one; a success carries `usageDate` only when a slot was actually
 * reserved, so callers keep refund and audit behaviour identical on the
 * whitelist / enforcement-off bypass.
 */
export type ReserveResult =
  | { allowed: true; usageDate?: string }
  | { allowed: false; reason?: ChatQuotaDenyReason; limit: number };

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
  | 'delivery_not_confirmed';

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
 *
 * A deny carries the limit that rejected it; a failure carries its cause.
 */
export type ChatPipelineResult =
  | { outcome: 'delivered' }
  | { outcome: 'denied'; reason?: ChatQuotaDenyReason; limit: number }
  | { outcome: 'duplicate' }
  | { outcome: 'failed'; reason: ChatPipelineFailureReason };

/**
 * Whether a flush ended without a retryable delivery failure. Denials and
 * duplicates are handled outcomes; a rate-limited send is a handled drop, so
 * only a delivery that was not confirmed (or an exception) is retryable.
 */
export function isTerminalFlush(result: ChatPipelineResult): boolean {
  return result.outcome !== 'failed' || result.reason === 'rate_limited';
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
    ctx: PipelineContext & { reason?: ChatQuotaDenyReason; limit: number },
  ) => Promise<void>;
  /** Called at each pipeline step for tracing/metrics. */
  onStep?: (step: string, ctx: PipelineContext) => Promise<void>;
}

// ── Pipeline config ─────────────────────────────────────────────────────────

export interface ChatPipelineConfig {
  /** Max characters for merged user text. Default: 4000. */
  mergedTextMaxChars?: number;
  /**
   * Times one pipeline step, so platforms keep their own duration metric and
   * span per step. Quota reserve is timed as `rate_limit_reserve` — the step
   * name Messenger's `chat_step_duration_seconds{step=…}` series already uses.
   */
  timeStep?: <T>(step: string, fn: () => Promise<T>) => Promise<T>;
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
