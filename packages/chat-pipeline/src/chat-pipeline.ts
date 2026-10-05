import type {
  AgentPort,
  ChatPipelineConfig,
  ChatPipelineHooks,
  ChatPipelineInput,
  ChatPipelineResult,
  HistoryPort,
  OutboundPort,
  PipelineContext,
  RateLimiterPort,
  ReserveResult,
} from './types';

const DEFAULT_MERGED_TEXT_MAX_CHARS = 4000;

function capUserTextParts(
  parts: readonly string[],
  maxChars: number,
): readonly string[] {
  const joined = parts.join('\n');
  if (joined.length <= maxChars) {
    return parts;
  }

  const bounded: string[] = [];
  let remaining = maxChars;
  for (const [index, part] of parts.entries()) {
    const separatorLength = index > 0 ? 1 : 0;
    const available = remaining - separatorLength;
    if (available < 0) break;

    const clipped = part.slice(0, available);
    bounded.push(clipped);
    remaining -= separatorLength + clipped.length;
    if (clipped.length < part.length) break;
  }
  return bounded;
}

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
   * The single quota owner: reserves, refunds and finalizes here.
   */
  async flush(input: ChatPipelineInput): Promise<ChatPipelineResult> {
    const mergedText = input.texts.join('\n').slice(0, this.mergedTextMaxChars);
    const userTextParts = capUserTextParts(
      input.userTextParts ?? input.texts,
      mergedText.length,
    );

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

      if (input.idempotencyKey) {
        const reserveResult: ReserveResult = await this.rateLimiter.reserve(
          input.externalUserId,
          input.idempotencyKey,
          { userId: input.userId },
        );

        if (!reserveResult.allowed) {
          if (reserveResult.reason === 'IDEMPOTENCY_CONFLICT') {
            return { outcome: 'duplicate' };
          }
          try {
            await this.hooks.onQuotaDenied?.({
              ...ctx,
              ...(reserveResult.reason !== undefined
                ? { reason: reserveResult.reason }
                : {}),
              limit: reserveResult.limit,
            });
          } catch {
            // Deny messaging must never turn a handled drop into a retry.
          }
          return {
            outcome: 'denied',
            ...(reserveResult.reason !== undefined
              ? { reason: reserveResult.reason }
              : {}),
            limit: reserveResult.limit,
          };
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
        userTextParts,
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
        return { outcome: 'failed', reason: 'rate_limited' };
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
          // Error hooks own their delivery-failure logging; preserve the failed outcome.
        }
        return { outcome: 'failed', reason: 'delivery_not_confirmed' };
      }

      // ── Canned clarification turns never consume quota (#959/#661) ────────
      // The reply delivered, but it answers nothing — release the reserved
      // slot and leave the idempotency row refunded. The markDelivered /
      // markCompleted bookkeeping below is skipped: the row is terminal.
      if (reply.clarification === true) {
        if (input.idempotencyKey && usageDate && !refundAttempted) {
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
        await this.hooks.onStep?.('after_send', ctx);
        return { outcome: 'delivered' };
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

      return { outcome: 'delivered' };
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
