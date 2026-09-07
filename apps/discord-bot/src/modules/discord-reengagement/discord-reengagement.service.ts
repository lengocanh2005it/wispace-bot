import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { BotMetricsService } from '@wispace/bot-metrics';
import { ReengagementApiClient } from '@wispace/wispace-client';
import type {
  ReengagementPayload,
  ReengagementSendStatus,
} from '@wispace/wispace-client';
import { DiscordOutboundService } from '../discord-chat/application/services/discord-outbound.service';
import { DiscordAccountLinkService } from '../account-link/application/services/discord-account-link.service';

export type ReengagementRunOnceOutcome =
  | 'sent'
  | 'ambiguous'
  | 'rate_limited'
  | 'failed';

export interface ReengagementRunOnceResult {
  outcome: ReengagementRunOnceOutcome;
  /** Machine-readable failure detail: not_linked, payload_error:<status>, mark-sent:<status>. */
  reason?: string;
  messageId?: string;
  /** Result of the backend mark-sent call; absent when nothing was sent or payload failed. */
  markSent?: { success: boolean; logId?: string | null; error?: string };
}

interface MarkSentAttempt {
  success: boolean;
  logId?: string | null;
  error?: string;
}

/**
 * End-to-end re-engagement send for ONE learner (#853): payload → proactive
 * DM → mark-sent. Dormancy-gate carve-out (#595): this path deliberately never
 * consults WebActivityService — a dormant learner is a valid recipient.
 * Consent (#596): the manual run-once trigger is an explicit operator action
 * (like forceSend); the opt-in filter lives in the batch scan (#854).
 */
@Injectable()
export class DiscordReengagementService {
  private readonly logger = new Logger(DiscordReengagementService.name);

  constructor(
    private readonly reengagementClient: ReengagementApiClient,
    private readonly outbound: DiscordOutboundService,
    private readonly accountLink: DiscordAccountLinkService,
    @Optional()
    @Inject(BotMetricsService)
    private readonly metrics?: BotMetricsService,
  ) {}

  async runOnce(
    userId: number,
    options?: { daysInactive?: number },
  ): Promise<ReengagementRunOnceResult> {
    const discordUserId = await this.accountLink.findDiscordIdByUserId(userId);
    if (!discordUserId) {
      this.metrics?.incReengagementSend('failed');
      return { outcome: 'failed', reason: 'not_linked' };
    }

    let payload: ReengagementPayload;
    try {
      payload = await this.reengagementClient.getPayload(String(userId), {
        platform: 'discord',
      });
    } catch (error) {
      this.logger.warn(
        `Re-engagement payload failed for userId=${maskExternalId(String(userId))}: ${errorMessage(error)}`,
      );
      this.metrics?.incReengagementSend('failed');
      return {
        outcome: 'failed',
        reason: `payload_error:${this.statusOf(error)}`,
      };
    }

    const delivery = await this.outbound.sendProactivePayload(
      discordUserId,
      payload.discord_payload,
      { userId },
    );

    if (delivery.outcome === 'sent' || delivery.outcome === 'ambiguous') {
      // Ambiguous → SUCCESS (anti-duplicate bias): marking FAILED would leave
      // suppression unarmed and risk a duplicate DM next cycle.
      const markSent = await this.recordMarkSent(
        userId,
        payload.variant,
        'SUCCESS',
        delivery.messageId,
        options?.daysInactive,
      );
      const messageId = delivery.messageId
        ? { messageId: delivery.messageId }
        : {};
      if (!markSent.success) {
        this.metrics?.incReengagementSend('mark_sent_error');
        return {
          outcome: delivery.outcome,
          ...messageId,
          reason: `mark-sent:${markSent.error ?? 'failed'}`,
          markSent,
        };
      }
      this.metrics?.incReengagementSend(delivery.outcome);
      return {
        outcome: delivery.outcome,
        ...messageId,
        markSent,
      };
    }

    const markSent = await this.recordMarkSent(
      userId,
      payload.variant,
      'FAILED',
      undefined,
      options?.daysInactive,
    );
    if (delivery.outcome === 'not_sent') {
      this.metrics?.incReengagementSend('failed');
      return { outcome: 'failed', reason: 'not_sent', markSent };
    }
    this.metrics?.incReengagementSend(delivery.outcome);
    return { outcome: delivery.outcome, markSent };
  }

  private async recordMarkSent(
    userId: number,
    variant: ReengagementPayload['variant'],
    status: ReengagementSendStatus,
    messageId: string | undefined,
    daysInactive?: number,
  ): Promise<MarkSentAttempt> {
    try {
      const result = await this.reengagementClient.markSent({
        userId: String(userId),
        platform: 'discord',
        variant,
        status,
        ...(messageId !== undefined ? { messageId } : {}),
        ...(daysInactive !== undefined ? { daysInactive } : {}),
      });
      return { success: result.success, logId: result.logId };
    } catch (error) {
      // Send is at-least-once: a failed mark-sent after a successful DM is
      // surfaced, not swallowed — suppression may lag one cycle (#850).
      this.logger.warn(
        `Re-engagement mark-sent (${status}) failed for userId=${maskExternalId(String(userId))}: ${errorMessage(error)}`,
      );
      return { success: false, error: String(this.statusOf(error)) };
    }
  }

  private statusOf(error: unknown): string {
    const status = (error as { statusCode?: unknown } | null)?.statusCode;
    return typeof status === 'number' ? String(status) : 'unknown';
  }
}
