/**
 * Narrow port interfaces for the chat flush pipeline.
 * Each platform maps its service methods to these ports.
 */

// ── Rate Limiter ────────────────────────────────────────────────────────────

export interface ReserveResult {
  allowed: boolean;
  usageDate?: string;
  reason?: string;
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
  markCompleted(idempotencyKey: string): Promise<void>;
}

// ── History ─────────────────────────────────────────────────────────────────

export interface HistoryPort {
  getHistory(externalUserId: string): Promise<readonly ChatHistoryMessage[]>;
  appendTurn(
    externalUserId: string,
    userText: string,
    assistantText: string,
  ): Promise<void>;
}

export interface ChatHistoryMessage {
  role: 'user' | 'assistant' | 'tool_summary';
  content: string;
}

// ── Agent ───────────────────────────────────────────────────────────────────

export interface AgentInput {
  externalUserId: string;
  userId?: number;
  userText: string;
  history: readonly ChatHistoryMessage[];
  correlationId?: string;
  /** Platform-specific context (e.g. Discord server channel flag). */
  context?: Record<string, unknown>;
}

export interface AgentReply {
  text: string;
  toolSummary?: string;
  richFollowUps?: unknown[];
}

export interface AgentPort {
  reply(input: AgentInput): Promise<AgentReply>;
}

// ── Outbound ────────────────────────────────────────────────────────────────

export interface SendResult {
  delivered: boolean;
}

export interface OutboundPort {
  sendText(
    externalUserId: string,
    text: string,
    context?: Record<string, unknown>,
  ): Promise<SendResult>;
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
}

// ── Hooks ───────────────────────────────────────────────────────────────────

export interface ChatPipelineHooks {
  /** Called before outbound.sendText. E.g. sender actions (typing_on, mark_seen). */
  onBeforeSend?: (ctx: PipelineContext) => Promise<void>;
  /** Called after main reply delivered successfully. E.g. rich follow-ups, quota hints. */
  onAfterSend?: (ctx: PipelineContext) => Promise<void>;
  /** Called on error before main reply delivered. E.g. fallback error message. */
  onError?: (ctx: PipelineContext) => Promise<void>;
  /** Called at each pipeline step for tracing/metrics. */
  onStep?: (step: string, ctx: PipelineContext) => Promise<void>;
}

// ── Pipeline config ─────────────────────────────────────────────────────────

export interface ChatPipelineConfig {
  /** Max characters for merged user text. Default: 4000. */
  mergedTextMaxChars?: number;
}
