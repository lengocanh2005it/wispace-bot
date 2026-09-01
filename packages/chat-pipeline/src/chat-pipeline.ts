import type {
  AgentPort,
  ChatPipelineConfig,
  ChatPipelineHooks,
  ChatPipelineInput,
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
 * Orchestrates: reserve quota → load history → call agent → send reply →
 * mark delivery → append history → mark completed. Optional hooks let platforms inject tracing,
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
  async flush(input: ChatPipelineInput): Promise<boolean> {
    const mergedText = input.texts.join('\n').slice(0, this.mergedTextMaxChars);

    const ctx: PipelineContext = {
      externalUserId: input.externalUserId,
      userId: input.userId,
      mergedText,
      idempotencyKey: input.idempotencyKey,
    };

    let delivered = false;
    let usageDate: string | undefined;
    let refundAttempted = false;
    let errorHookCalled = false;
    let rateLimited = false;

    try {
      // ── Reserve quota ─────────────────────────────────────────────────────
      await this.hooks.onStep?.('before_reserve', ctx);

      if (input.idempotencyKey && input.reservedUsageDate === undefined) {
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
      } else if (input.idempotencyKey) {
        usageDate = input.reservedUsageDate;
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
        context: input.context,
      });

      ctx.reply = reply;

      // ── Send reply ────────────────────────────────────────────────────────
      if (reply.skipDelivery) {
        // A duplicate webhook/worker replay has already attempted this
        // canned clarification. Mark the idempotency row terminal without
        // sending a second user-visible reply.
        delivered = true;
      } else if (reply.text.trim()) {
        await this.hooks.onBeforeSend?.(ctx);
        await this.hooks.onStep?.('before_send', ctx);

        const sendResult = await this.outbound.sendText(
          input.externalUserId,
          reply.text,
          {
            userId: input.userId,
            ...(reply.deliveryKey ? { deliveryKey: reply.deliveryKey } : {}),
            ...(reply.clarification ? { clarification: true } : {}),
          },
        );

        delivered = sendResult.delivered;
        ctx.partialDelivery = sendResult.partial === true;
        rateLimited = sendResult.outcome === 'rate_limited';
      }

      if (rateLimited) {
        if (input.idempotencyKey && usageDate) {
          refundAttempted = true;
          try {
            await this.rateLimiter.refund(
              input.externalUserId,
              usageDate,
              input.idempotencyKey,
            );
          } catch (refundError) {
            ctx.refundError = refundError;
          }
        }
        try {
          await this.hooks.onRateLimited?.(ctx);
        } catch {
          // Rate-limit handling must never turn a handled drop into a retry.
        }
        return false;
      }

      if (!delivered && !ctx.partialDelivery) {
        if (input.idempotencyKey && usageDate) {
          refundAttempted = true;
          try {
            await this.rateLimiter.refund(
              input.externalUserId,
              usageDate,
              input.idempotencyKey,
            );
          } catch (refundError) {
            ctx.refundError = refundError;
          }
        }

        ctx.error = new Error('Chat response delivery was not confirmed');
        errorHookCalled = true;
        try {
          await this.hooks.onError?.(ctx);
        } catch {
          // Error hooks own their delivery-failure logging; preserve the false result.
        }
        return false;
      }

      // ── Persist delivery before history/quota finalization ───────────────
      if (input.idempotencyKey) {
        await this.rateLimiter.markDelivered(input.idempotencyKey);
      }

      if (!reply.skipHistory) {
        await this.history.appendTurn(
          input.externalUserId,
          mergedText,
          reply.text,
          reply.toolSummary,
        );
      }

      // A confirmed delivery must never be refunded just because quota
      // finalization is temporarily unavailable. The delivered row is durable
      // recovery state; the existing stuck-recovery cron completes it later.
      if (input.idempotencyKey) {
        try {
          await this.rateLimiter.markCompleted(input.idempotencyKey);
        } catch (error) {
          ctx.quotaFinalizationError = error;
          try {
            await this.hooks.onStep?.('quota_finalize_failed', ctx);
          } catch {
            // Observability hooks must not turn a delivered reply into a retry.
          }
        }
      }

      if (delivered) {
        await this.hooks.onStep?.('after_send', ctx);
        await this.hooks.onAfterSend?.(ctx);
      }

      return delivered;
    } catch (error) {
      ctx.deliveryAmbiguous =
        this.outbound.isAmbiguousDeliveryError?.(error) === true;
      // ── Refund on error before delivery ──────────────────────────────────
      if (!delivered && input.idempotencyKey && usageDate && !refundAttempted) {
        refundAttempted = true;
        try {
          await this.rateLimiter.refund(
            input.externalUserId,
            usageDate,
            input.idempotencyKey,
          );
        } catch (refundError) {
          ctx.refundError = refundError;
        }
      }

      ctx.error = error;
      if (!delivered && !errorHookCalled) {
        errorHookCalled = true;
        try {
          await this.hooks.onError?.(ctx);
        } catch {
          // Error hooks own their delivery-failure logging; preserve the original error.
        }
      }

      throw error;
    }
  }
}
