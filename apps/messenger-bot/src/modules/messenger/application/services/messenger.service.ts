import { createHash } from 'node:crypto';
import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pLimit from 'p-limit';
import { maskEventId, maskExternalId } from '@wispace/bot-common/masking';
import { TRY_INLINE_DISPATCHER } from '@wispace/webhook-inbound';
import { MessengerLinkContext } from '@messenger/shared/config/poc.constants';
import { MESSENGER_REPOSITORY } from '../../domain/repositories/messenger.repository.port';
import type { MessengerMappingRepositoryPort } from '../../domain/repositories/messenger-mapping.repository.port';
import { WEBHOOK_INBOUND_EVENTS_PORT } from '../../domain/repositories/webhook-inbound-events.port';
import type { WebhookInboundEventsPort } from '../../domain/repositories/webhook-inbound-events.port';
import {
  MessengerWebhookEvent,
  MessengerWebhookPayload,
  UserMessengerMapping,
} from '../../domain/entities/messenger.types';
import { MessengerLinkContextService } from './messenger-link-context.service';
import { MessengerOutboundService } from './messenger-outbound.service';
import { ChatRateLimitConfigService } from '@messenger/modules/chat-rate-limit/application/services/chat-rate-limit-config.service';
import {
  extractRefFromEvent,
  routeWebhookEvent,
  RouterContext,
} from '../messenger-webhook.router';
import type { RefVerification } from '../types/messenger-webhook-router.types';
import { WebhookActionExecutorService } from './webhook-action-executor.service';

export { MessengerApiError } from './messenger-outbound.service';

/** Maximum length for event IDs stored in varchar(255) DB columns. */
export const MAX_EVENT_ID_LENGTH = 255;

/** Maximum length for idempotency keys stored in varchar(128) DB columns. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/** Stable per-delivery event id for the durable inbox. */
export function buildEventId(
  event: MessengerWebhookEvent,
  psid: string,
): string {
  if (event.message?.mid) {
    return event.message.mid;
  }
  if (event.timestamp !== undefined) {
    if (event.postback?.payload) {
      const raw = `pb:${psid}:${event.postback.payload}:${event.timestamp}`;
      if (raw.length <= MAX_EVENT_ID_LENGTH) {
        return raw;
      }
      // Bound long payloads: hash the payload to fit within varchar(255)
      const payloadHash = createHash('sha256')
        .update(event.postback.payload)
        .digest('hex')
        .slice(0, 32);
      return `pb:${psid}:${payloadHash}:${event.timestamp}`;
    }
    return `evt:${psid}:${event.timestamp}`;
  }
  const fingerprint = createHash('sha256')
    .update(canonicalize({ psid, event }))
    .digest('hex');
  return `${event.postback?.payload ? 'pb' : 'evt'}:${fingerprint}`;
}

/**
 * Deterministic idempotency key for chat rate limiting, bounded to
 * varchar(128). Uses SHA-256 for collision resistance within the limit.
 */
export function buildIdempotencyKey(
  event: MessengerWebhookEvent,
  psid: string,
): string {
  const raw = buildEventId(event, psid);
  if (raw.length <= MAX_IDEMPOTENCY_KEY_LENGTH) {
    return raw;
  }
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 32);
  return `idem:${hash}`;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`;
}

function buildEventType(event: MessengerWebhookEvent): string {
  if (event.postback) return 'postback';
  if (event.message) return 'message';
  if (event.referral) return 'referral';
  if (event.optin) return 'optin';
  return 'unsupported';
}

@Injectable()
export class MessengerService {
  private readonly logger = new Logger(MessengerService.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(MESSENGER_REPOSITORY)
    private readonly repository: MessengerMappingRepositoryPort,
    private readonly outbound: MessengerOutboundService,
    private readonly messengerLinkContextService: MessengerLinkContextService,
    private readonly chatRateLimitConfig: ChatRateLimitConfigService,
    private readonly actionExecutor: WebhookActionExecutorService,
    @Inject(WEBHOOK_INBOUND_EVENTS_PORT)
    private readonly inboundEvents: WebhookInboundEventsPort,
    @Optional()
    @Inject(TRY_INLINE_DISPATCHER)
    private readonly tryInlineDispatcher?:
      | ((
          id: number,
          rawPayload: object,
          meta: { ingestedAt: Date; eventId: string; externalUserId: string },
        ) => void)
      | null,
  ) {}

  verifyWebhook(token?: string, challenge?: string): string {
    if (token !== this.configService.get<string>('VERIFY_TOKEN')) {
      throw new ForbiddenException('Invalid verify token');
    }

    return challenge ?? '';
  }

  /**
   * Durable ingestion: every authenticated event is persisted to the inbox
   * (`webhook_inbound_events`) BEFORE acknowledging. Downstream processing is
   * owned by the retry cron after the endpoint returns. A duplicate delivery
   * is skipped (idempotent), and a persistence failure propagates so the
   * endpoint answers non-2xx and the platform redelivers.
   */
  async handleWebhook(payload: MessengerWebhookPayload): Promise<{
    accepted: number;
    duplicates: number;
  }> {
    // Count entries BEFORE flatten to reject oversized batches early (#365).
    // The boundary mapper permits up to 50 entries × 500 events, but the
    // service default accepts only 50 total events. Reject before per-event
    // logging or construction of the full ingestion work list.
    const maxBatchSize = this.configService.get<number>(
      'WEBHOOK_MAX_BATCH_SIZE',
      50,
    );
    let totalEventCount = 0;
    for (const entry of payload.entry) {
      totalEventCount += entry.messaging.length;
    }
    if (totalEventCount > maxBatchSize) {
      this.logger.warn(
        `Webhook batch rejected: ${totalEventCount} events exceeds limit ${maxBatchSize}`,
      );
      throw new PayloadTooLargeException(
        `Batch size ${totalEventCount} exceeds limit ${maxBatchSize}`,
      );
    }

    // Flatten all events from the batch for parallel ingestion (#155).
    const events: Array<{
      event: MessengerWebhookEvent;
      eventId: string;
    }> = [];

    for (const entry of payload.entry) {
      for (const event of entry.messaging) {
        this.logIncomingWebhookEvent(event);
        const eventId = buildEventId(event, event.sender?.id ?? '');
        events.push({ event, eventId });
      }
    }

    if (events.length === 0) {
      return { accepted: 0, duplicates: 0 };
    }

    // Bounded parallel insert — unique constraint handles idempotency.
    // p-limit caps concurrent DB inserts; Promise.allSettled processes all events.
    const limit = pLimit(5);
    const results = await Promise.allSettled(
      events.map(({ event, eventId }) =>
        limit(() =>
          this.inboundEvents
            .ingest({
              eventId,
              externalUserId: event.sender?.id ?? null,
              eventType: buildEventType(event),
              rawPayload: event,
            })
            .then((result) => ({
              eventId,
              rawPayload: event,
              ...result,
            })),
        ),
      ),
    );

    let accepted = 0;
    let duplicates = 0;
    const failures: string[] = [];

    for (const result of results) {
      if (result.status === 'rejected') {
        failures.push(String(result.reason));
        continue;
      }
      if (!result.value.inserted) {
        duplicates += 1;
        this.logger.debug(
          `Skipping duplicate webhook event id=${maskEventId(
            result.value.eventId,
            undefined,
          )}`,
        );
        continue;
      }
      accepted += 1;

      if (this.tryInlineDispatcher) {
        const raw = result.value.rawPayload as MessengerWebhookEvent;
        this.tryInlineDispatcher(result.value.id!, raw as object, {
          ingestedAt: new Date(),
          eventId: result.value.eventId,
          externalUserId: raw.sender?.id ?? '',
        });
      }
    }

    if (failures.length > 0) {
      this.logger.error(
        `Webhook ingestion: ${failures.length}/${events.length} events failed to persist`,
      );
      // Propagate so the endpoint returns non-2xx and Meta redelivers.
      throw new Error(
        `Webhook ingestion failed: ${failures.length}/${events.length} events`,
      );
    }

    return { accepted, duplicates };
  }

  private logIncomingWebhookEvent(event: MessengerWebhookEvent): void {
    const eventTypes = [
      event.optin ? 'optin' : null,
      event.postback ? 'postback' : null,
      event.message ? 'message' : null,
      event.referral ? 'referral' : null,
    ].filter(Boolean);

    this.logger.log(`Webhook event: ${eventTypes.join(', ') || 'unknown'}`);
  }

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
    if (refVerification?.status === 'verified') {
      linkContext = refVerification.context;
    } else {
      linkContext = await this.resolveLinkContextFromMapping(
        psid,
        existingMapping,
      );
    }

    return {
      userId:
        refVerification?.status === 'verified'
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
    return { status: 'verified', context: outcome.context };
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
      if (rv.status === 'verified') {
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
