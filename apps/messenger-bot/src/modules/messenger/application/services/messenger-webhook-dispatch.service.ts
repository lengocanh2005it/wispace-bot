import { Inject, Injectable, Logger } from '@nestjs/common';
import { maskExternalId } from '@wispace/bot-common/masking';
import type { MessengerLinkContext } from '@messenger/shared/config/poc.constants';
import { MESSENGER_REPOSITORY } from '../../domain/repositories/messenger.repository.port';
import type { MessengerMappingRepositoryPort } from '../../domain/repositories/messenger-mapping.repository.port';
import type {
  MessengerWebhookEvent,
  UserMessengerMapping,
} from '../../domain/entities/messenger.types';
import {
  extractRefFromEvent,
  routeWebhookEvent,
  type RouterContext,
} from '../messenger-webhook.router';
import type { RefVerification } from '../types/messenger-webhook-router.types';
import { MessengerLinkContextService } from './messenger-link-context.service';
import { MessengerOutboundService } from './messenger-outbound.service';
import { ChatRateLimitConfigService } from '@messenger/modules/chat-rate-limit/application/services/chat-rate-limit-config.service';
import { WebhookActionExecutorService } from './webhook-action-executor.service';
import { buildIdempotencyKey } from './messenger-event-id';

/**
 * Applies one authenticated Messenger inbound event: resolves the learner's
 * identity, routes the event, and executes the resulting actions.
 *
 * This is the leaf half of the webhook pair. It exists as its own service so
 * `InlineWebhookInboundDispatcher` can inject it directly: when this logic lived
 * on `MessengerService`, that service injected `TRY_INLINE_DISPATCHER` while
 * the dispatcher's own `processEvent` callback needed `MessengerService` back —
 * a cycle Nest cannot express, so the factory reached for
 * `moduleRef.get(MessengerService, { strict: false })` and the dependency
 * became invisible. `MessengerService` now owns only ingestion and never
 * imports this service, so nothing routes back through it.
 */
@Injectable()
export class MessengerWebhookDispatchService {
  private readonly logger = new Logger(MessengerWebhookDispatchService.name);

  constructor(
    @Inject(MESSENGER_REPOSITORY)
    private readonly repository: MessengerMappingRepositoryPort,
    private readonly outbound: MessengerOutboundService,
    private readonly messengerLinkContextService: MessengerLinkContextService,
    private readonly chatRateLimitConfig: ChatRateLimitConfigService,
    private readonly actionExecutor: WebhookActionExecutorService,
  ) {}

  /**
   * Re-process a stored inbound event (retry cron). Duplicate detection is
   * already handled by the inbox — this bypasses `ingest`.
   */
  async processEvent(event: MessengerWebhookEvent): Promise<boolean> {
    const psid = event.sender?.id;
    if (!psid) {
      this.logger.warn('Ignored Messenger event without sender.id');
      return false;
    }

    const ctx = await this.preResolveContext(psid, event);
    const actions = routeWebhookEvent(event, ctx);

    for (const action of actions) {
      const actionForExecution =
        action.type === 'enqueue_chat' && !action.idempotencyKey
          ? { ...action, idempotencyKey: buildIdempotencyKey(event, psid) }
          : action;

      if (
        actionForExecution.type === 'send_text' ||
        actionForExecution.type === 'ignore'
      ) {
        if (actionForExecution.type === 'send_text') {
          this.signalMessageSeen(psid);
        }
        await this.actionExecutor.executeAction(
          actionForExecution,
          event,
          this.resolveLinkContextForChat.bind(this),
        );
      } else {
        // Fire-and-forget — the typing roundtrip must not block the webhook.
        this.signalTyping(psid);
        await this.actionExecutor.executeAction(
          actionForExecution,
          event,
          (eventPsid, eventObj) =>
            this.resolveLinkContextForChat(eventPsid, eventObj, ctx),
        );
      }
    }

    return actions.length > 0 && actions[0].type !== 'ignore';
  }

  private async preResolveContext(
    psid: string,
    event: MessengerWebhookEvent,
  ): Promise<RouterContext> {
    const existingMapping = await this.repository.findActiveMappingByPsid(psid);

    const shouldEnforceRateLimit =
      this.chatRateLimitConfig.shouldEnforceForPsid(psid);

    // #383: verify an event-carried ref exactly once, for every Meta shape
    // (opt-in, top-level referral, postback referral, message referral). The
    // token is single-use — downstream link actions reuse the verified
    // context instead of re-submitting it.
    let refVerification: RefVerification | undefined;
    const ref = extractRefFromEvent(event);
    if (ref) {
      refVerification = await this.verifyEventRef(
        psid,
        event,
        ref,
        existingMapping,
      );
    }

    let linkContext: RouterContext['linkContext'];
    if (
      (refVerification?.status === 'verified' ||
        refVerification?.status === 'committed') &&
      refVerification.context
    ) {
      linkContext = refVerification.context;
    } else {
      linkContext = await this.resolveLinkContextFromMapping(
        psid,
        existingMapping,
      );
    }

    return {
      userId:
        refVerification?.status === 'verified' ||
        refVerification?.status === 'committed'
          ? refVerification.context?.userId
          : existingMapping?.userId,
      linkContext: linkContext ?? undefined,
      shouldEnforceRateLimit,
      refVerification,
    };
  }

  private async verifyEventRef(
    psid: string,
    event: MessengerWebhookEvent,
    ref: string,
    existingMapping: UserMessengerMapping | null,
  ): Promise<RefVerification> {
    const outcome = await this.messengerLinkContextService.resolveFromRef(
      psid,
      {
        ref,
        topic: event.optin?.topic,
        cadence: event.optin?.frequency,
      },
    );

    if (outcome.verifyFailureReason) {
      return { status: 'failed', failureReason: outcome.verifyFailureReason };
    }
    if (outcome.handoffFailure) {
      return { status: 'handoff_failed' };
    }
    if (!outcome.context) {
      // resolveFromRef returns a context or a failure reason; treat the
      // impossible remainder as a generic verification failure.
      return { status: 'failed', failureReason: 'NOT_FOUND' };
    }
    if (
      existingMapping?.userId != null &&
      existingMapping.userId !== outcome.context.userId
    ) {
      this.logger.warn(
        `REF_LINK_BLOCKED psid=${maskExternalId(psid)} mappedUser=${maskExternalId(
          String(existingMapping.userId),
        )} refUser=${maskExternalId(String(outcome.context.userId))}`,
      );
      return { status: 'blocked' };
    }
    if (outcome.intentState === 'committed') {
      const currentMapping =
        await this.repository.findActiveMappingByPsid(psid);
      if (currentMapping?.userId !== outcome.context.userId) {
        return { status: 'failed', failureReason: 'USED' };
      }
    }
    return {
      status: outcome.intentState === 'committed' ? 'committed' : 'verified',
      context: outcome.context,
      intentGeneration: outcome.intentGeneration,
      ...(outcome.intentLeaseToken
        ? { intentLeaseToken: outcome.intentLeaseToken }
        : {}),
    };
  }

  private async resolveLinkContextFromMapping(
    psid: string,
    existingMapping?: UserMessengerMapping | null,
  ): Promise<MessengerLinkContext | undefined> {
    const mapping =
      existingMapping ?? (await this.repository.findActiveMappingByPsid(psid));
    if (!mapping?.userId) {
      return undefined;
    }

    return this.messengerLinkContextService.resolveFromMapping({
      userId: mapping.userId,
      topic: mapping.topic,
      cadence: mapping.cadence,
    });
  }

  private async resolveLinkContextForChat(
    psid: string,
    event: MessengerWebhookEvent,
    preResolved?: RouterContext,
  ): Promise<MessengerLinkContext | undefined> {
    // #383: the ref (if any) was verified once during pre-resolve — honor
    // that outcome instead of re-submitting a single-use token.
    const rv = preResolved?.refVerification;
    if (rv) {
      if (rv.status === 'verified' || rv.status === 'committed') {
        return rv.context ?? preResolved?.linkContext ?? undefined;
      }
      // blocked/failed → identity stays with the active mapping.
      return preResolved?.linkContext ?? undefined;
    }

    const ref = extractRefFromEvent(event);
    if (ref) {
      const outcome = await this.messengerLinkContextService.resolveFromRef(
        psid,
        {
          ref,
          topic: event.optin?.topic,
          cadence: event.optin?.frequency,
        },
      );
      if (outcome.context) {
        return outcome.context;
      }
    }

    if (preResolved?.linkContext) {
      // Reuse the mapping already fetched in preResolveContext — avoids a
      // second identical DB lookup per chat message.
      return preResolved.linkContext;
    }

    return this.resolveLinkContextFromMapping(psid);
  }

  private signalMessageSeen(psid: string): void {
    void this.outbound.sendSenderActionOptional(psid, 'mark_seen');
  }

  private signalTyping(psid: string): void {
    void this.outbound.sendSenderActionOptional(psid, 'typing_on');
  }
}
