import { createHash } from 'node:crypto';
import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { maskEventId, maskExternalId } from '@wispace/bot-common';
import { PlatformWebhookInboundEventService } from '@wispace/database';
import { MessengerLinkContext } from '@messenger/shared/config/poc.constants';
import { MESSENGER_REPOSITORY } from '../../domain/repositories/messenger.repository.port';
import type { MessengerMappingRepositoryPort } from '../../domain/repositories/messenger-mapping.repository.port';
import {
  MessengerWebhookEvent,
  MessengerWebhookPayload,
  UserMessengerMapping,
} from '../../domain/entities/messenger.types';
import { MessengerLinkContextService } from './messenger-link-context.service';
import { MessengerOutboundService } from './messenger-outbound.service';
import { ChatRateLimitConfigService } from '@messenger/modules/chat-rate-limit/application/services/chat-rate-limit-config.service';
import { WEBHOOK_POSTBACK_DEDUPE_MS } from '../../domain/entities/messenger-store.types';
import {
  extractRefFromEvent,
  routeWebhookEvent,
  RouterContext,
} from '../messenger-webhook.router';
import { WebhookActionExecutorService } from './webhook-action-executor.service';

export { MessengerApiError } from './messenger-outbound.service';

/** Stable per-delivery event id for the durable inbox. */
function buildEventId(event: MessengerWebhookEvent, psid: string): string {
  if (event.message?.mid) {
    return event.message.mid;
  }
  if (event.timestamp !== undefined) {
    if (event.postback?.payload) {
      return `pb:${psid}:${event.postback.payload}:${event.timestamp}`;
    }
    return `evt:${psid}:${event.timestamp}`;
  }
  const fingerprint = createHash('sha256')
    .update(canonicalize({ psid, event }))
    .digest('hex');
  return `${event.postback?.payload ? 'pb' : 'evt'}:${fingerprint}`;
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

  /** In-memory double-tap debounce for postbacks (non-durable by design). */
  private readonly recentPostbacks = new Map<string, number>();

  constructor(
    private readonly configService: ConfigService,
    @Inject(MESSENGER_REPOSITORY)
    private readonly repository: MessengerMappingRepositoryPort,
    private readonly outbound: MessengerOutboundService,
    private readonly messengerLinkContextService: MessengerLinkContextService,
    private readonly chatRateLimitConfig: ChatRateLimitConfigService,
    private readonly actionExecutor: WebhookActionExecutorService,
    private readonly inboundEvents: PlatformWebhookInboundEventService,
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
    failures: Array<{ psid?: string; error: string }>;
  }> {
    const failures: Array<{ psid?: string; error: string }> = [];
    let accepted = 0;
    let duplicates = 0;

    for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
      for (const event of Array.isArray(entry.messaging)
        ? entry.messaging
        : []) {
        this.logIncomingWebhookEvent(event);

        // Double-tap debounce for postbacks (identical payload within 15s).
        if (event.postback?.payload && this.isRecentPostback(event)) {
          this.logger.debug(
            `Skipping recent postback ${event.postback.payload} for ${maskExternalId(event.sender?.id)}`,
          );
          continue;
        }

        const eventId = buildEventId(event, event.sender?.id ?? '');
        const { inserted } = await this.inboundEvents.ingest({
          eventId,
          externalUserId: event.sender?.id ?? null,
          eventType: buildEventType(event),
          rawPayload: event,
        });

        if (!inserted) {
          duplicates += 1;
          this.logger.debug(
            `Skipping duplicate webhook event id=${maskEventId(
              eventId,
              event.sender?.id,
            )}`,
          );
          continue;
        }
        accepted += 1;
      }
    }

    return { accepted, duplicates, failures };
  }

  private isRecentPostback(event: MessengerWebhookEvent): boolean {
    const psid = event.sender?.id ?? '';
    const payload = event.postback?.payload ?? '';
    const key = `${psid}:${payload}`;
    const now = Date.now();
    const last = this.recentPostbacks.get(key);

    if (last !== undefined && now - last < WEBHOOK_POSTBACK_DEDUPE_MS) {
      return true;
    }

    this.recentPostbacks.set(key, now);
    if (this.recentPostbacks.size > 1000) {
      this.recentPostbacks.clear();
    }
    return false;
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
          ? { ...action, idempotencyKey: buildEventId(event, psid) }
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

    let linkContext: RouterContext['linkContext'] = undefined;

    if (!event.optin && !event.referral?.ref) {
      const resolved = await this.resolveLinkContextFromMapping(
        psid,
        existingMapping,
      );
      if (resolved) {
        linkContext = resolved;
      }
    }

    return {
      userId: existingMapping?.userId,
      linkContext,
      shouldEnforceRateLimit,
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
