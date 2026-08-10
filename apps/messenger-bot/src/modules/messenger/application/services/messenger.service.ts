import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { errorMessage, maskExternalId } from '@wispace/bot-common';
import { MessengerLinkContext } from '@messenger/shared/config/poc.constants';
import { MESSENGER_REPOSITORY } from '../../domain/repositories/messenger.repository.port';
import type { MessengerMappingRepositoryPort } from '../../domain/repositories/messenger-mapping.repository.port';
import { WEBHOOK_DEDUPE_STORE } from '../../domain/repositories/webhook-dedupe.store.port';
import type { WebhookDedupeStorePort } from '../../domain/repositories/webhook-dedupe.store.port';
import { MESSENGER_WEBHOOK_DEAD_LETTER_REPOSITORY } from '../../domain/repositories/messenger-webhook-dead-letter.repository.port';
import type { MessengerWebhookDeadLetterRepositoryPort } from '../../domain/repositories/messenger-webhook-dead-letter.repository.port';
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
import { WebhookActionExecutorService } from './webhook-action-executor.service';

export { MessengerApiError } from './messenger-outbound.service';

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
    @Inject(WEBHOOK_DEDUPE_STORE)
    private readonly webhookDedupeStore: WebhookDedupeStorePort,
    @Optional()
    @Inject(MESSENGER_WEBHOOK_DEAD_LETTER_REPOSITORY)
    private readonly deadLetterRepository?: MessengerWebhookDeadLetterRepositoryPort,
  ) {}

  verifyWebhook(token?: string, challenge?: string): string {
    if (token !== this.configService.get<string>('VERIFY_TOKEN')) {
      throw new ForbiddenException('Invalid verify token');
    }

    return challenge ?? '';
  }

  async handleWebhook(payload: MessengerWebhookPayload): Promise<{
    processed: number;
    failures: Array<{ psid?: string; error: string }>;
  }> {
    const failures: Array<{ psid?: string; error: string }> = [];
    let processed = 0;

    for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
      for (const event of Array.isArray(entry.messaging)
        ? entry.messaging
        : []) {
        this.logIncomingWebhookEvent(event);
        try {
          const handled = await this.handleEvent(event);
          processed += handled ? 1 : 0;
        } catch (error) {
          const errorMessageValue = errorMessage(error);

          failures.push({ psid: event.sender?.id, error: errorMessageValue });

          this.logger.warn(
            `Webhook event for PSID ${maskExternalId(event.sender?.id)} failed — saving to dead-letter: ${errorMessageValue}`,
          );

          if (this.deadLetterRepository) {
            await this.deadLetterRepository
              .save({
                psid: event.sender?.id ?? null,
                messageMid: event.message?.mid ?? null,
                rawPayload: event,
                errorMessage: errorMessageValue,
              })
              .catch((saveErr: unknown) => {
                this.logger.error(
                  `Failed to save dead-letter entry: ${errorMessage(saveErr)}`,
                );
              });
          }

          // Forget the mid so a dead-letter replay re-processes the event —
          // otherwise the mid (marked before execution) makes replay a no-op.
          const mid = event.message?.mid;
          if (mid) {
            await this.forgetMessageMid(mid, event.sender?.id ?? '');
          }
        }
      }
    }

    return { processed, failures };
  }

  async replayWebhookEvent(
    rawPayload: object,
  ): Promise<{ handled: boolean; error?: string }> {
    const event = rawPayload as MessengerWebhookEvent;
    try {
      const handled = await this.handleEvent(event);
      return { handled };
    } catch (error) {
      return {
        handled: false,
        error: errorMessage(error),
      };
    }
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

  private async handleEvent(event: MessengerWebhookEvent): Promise<boolean> {
    const psid = event.sender?.id;
    if (!psid) {
      this.logger.warn('Ignored Messenger event without sender.id');
      return false;
    }

    const ctx = await this.preResolveContext(psid, event);
    const actions = routeWebhookEvent(event, ctx);

    for (const action of actions) {
      if (action.type === 'send_text' || action.type === 'ignore') {
        if (action.type === 'send_text') {
          this.signalMessageSeen(psid);
        }
        await this.actionExecutor.executeAction(
          action,
          event,
          this.resolveLinkContextForChat.bind(this),
        );
      } else {
        // Fire-and-forget — the typing roundtrip must not block the webhook.
        this.signalTyping(psid);
        await this.actionExecutor.executeAction(
          action,
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
    const [isDuplicateMid, isDuplicatePostback, existingMapping] =
      await Promise.all([
        event.message?.mid
          ? this.isDuplicateMessageMid(event.message.mid, psid)
          : undefined,
        event.postback?.payload
          ? this.isDuplicatePostback(psid, event.postback.payload)
          : undefined,
        this.repository.findActiveMappingByPsid(psid),
      ]);

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
      isDuplicateMid,
      isDuplicatePostback,
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

  private isDuplicateMessageMid(mid: string, psid: string): Promise<boolean> {
    return this.webhookDedupeStore.isDuplicateMessageMid(mid, psid);
  }

  private isDuplicatePostback(psid: string, payload: string): Promise<boolean> {
    return this.webhookDedupeStore.isDuplicatePostback(psid, payload);
  }

  private forgetMessageMid(mid: string, psid: string): Promise<void> {
    return this.webhookDedupeStore.forgetMessageMid(mid, psid);
  }
}
