import type {
  AgentPort,
  ChatPipelineConfig,
  ChatPipelineHooks,
  HistoryPort,
  OutboundPort,
  PipelineContext,
  RateLimiterPort,
  ReserveResult,
} from './types';

const DEFAULT_MERGED_TEXT_MAX_CHARS = 4000;

/**
 * Framework-agnostic chat flush pipeline.
 *
 * Orchestrates: reserve quota → load history → call agent → append history →
 * send reply → mark completed. Optional hooks let platforms inject tracing,
 * metrics, sender actions, and error fallbacks without the pipeline knowing.
 *
 * One module, small interface, lots of behaviour — the deletion test passes
 * because removing this reappears the same orchestration in every app.
 */
export class ChatPipeline {
  private readonly mergedTextMaxChars: number;

  constructor(
    private readonly rateLimiter: RateLimiterPort,
    private readonly history: HistoryPort,
    private readonly agent: AgentPort,
    private readonly outbound: OutboundPort,
    private readonly hooks: ChatPipelineHooks = {},
    config: ChatPipelineConfig = {},
  ) {
    this.mergedTextMaxChars =
      config.mergedTextMaxChars ?? DEFAULT_MERGED_TEXT_MAX_CHARS;
  }

  /**
   * Run the full flush pipeline for a batch of merged user texts.
   * Returns true if the main reply was delivered.
   */
  async flush(input: {
    externalUserId: string;
    userId?: number;
    texts: string[];
    idempotencyKey?: string;
  }): Promise<boolean> {
    const mergedText = input.texts.join('\n').slice(0, this.mergedTextMaxChars);

    const ctx: PipelineContext = {
      externalUserId: input.externalUserId,
      userId: input.userId,
      mergedText,
      idempotencyKey: input.idempotencyKey,
    };

    let delivered = false;
    let usageDate: string | undefined;

    try {
      // ── Reserve quota ─────────────────────────────────────────────────────
      await this.hooks.onStep?.('before_reserve', ctx);

      if (input.idempotencyKey) {
        const reserveResult: ReserveResult = await this.rateLimiter.reserve(
          input.externalUserId,
          input.idempotencyKey,
          { userId: input.userId },
        );

        if (!reserveResult.allowed) {
          return false;
        }

        usageDate = reserveResult.usageDate;
        ctx.usageDate = usageDate;
      }

      // ── Load history ──────────────────────────────────────────────────────
      await this.hooks.onStep?.('before_history', ctx);

      const history = await this.history.getHistory(input.externalUserId);

      // ── Call agent ────────────────────────────────────────────────────────
      await this.hooks.onStep?.('before_agent', ctx);

      const reply = await this.agent.reply({
        externalUserId: input.externalUserId,
        userId: input.userId,
        userText: mergedText,
        history,
        correlationId: input.idempotencyKey,
      });

      ctx.reply = reply;

      // ── Append history ────────────────────────────────────────────────────
      if (reply.text.trim()) {
        await this.history.appendTurn(
          input.externalUserId,
          mergedText,
          reply.text,
        );
      }

      // ── Send reply ────────────────────────────────────────────────────────
      if (reply.text.trim()) {
        await this.hooks.onBeforeSend?.(ctx);
        await this.hooks.onStep?.('before_send', ctx);

        const sendResult = await this.outbound.sendText(
          input.externalUserId,
          reply.text,
          { userId: input.userId },
        );

        delivered = sendResult.delivered;
      }

      // ── Mark completed ────────────────────────────────────────────────────
      if (input.idempotencyKey) {
        await this.rateLimiter.markCompleted(input.idempotencyKey);
      }

      if (delivered) {
        await this.hooks.onStep?.('after_send', ctx);
        await this.hooks.onAfterSend?.(ctx);
      }

      return delivered;
    } catch (error) {
      // ── Refund on error before delivery ──────────────────────────────────
      if (!delivered && input.idempotencyKey && usageDate) {
        await this.rateLimiter.refund(
          input.externalUserId,
          usageDate,
          input.idempotencyKey,
        );
      }

      ctx.error = error;
      await this.hooks.onError?.(ctx);

      throw error;
    }
  }
}
