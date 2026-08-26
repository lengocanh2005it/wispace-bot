import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PgAdvisoryLockService } from '@wispace/bot-common';
import { subDays } from 'date-fns';
import { PlatformWebhookInboundEventService } from './platform-webhook-inbound-event.service';

const DEFAULT_RETENTION_DAYS = 30;

export interface WebhookInboundCleanupOptions {
  /** Advisory lock id — only one pod cleans the inbox per tick. */
  lockId: number;
}

/**
 * Retention policy for raw webhook payloads stored in the durable inbox
 * (`webhook_inbound_events`). Terminal rows (`completed`/`abandoned`) are
 * deleted after `WEBHOOK_INBOUND_RETENTION_DAYS` (default 30) — non-terminal
 * rows are never touched, so pending retries and the stale-`processing`
 * recovery keep working. Advisory-locked for multi-pod safety.
 */
@Injectable()
export class PlatformWebhookInboundCleanupService {
  private readonly logger = new Logger(
    PlatformWebhookInboundCleanupService.name,
  );

  constructor(
    private readonly inboundEvents: PlatformWebhookInboundEventService,
    private readonly configService: ConfigService,
    private readonly pgLock: PgAdvisoryLockService,
    private readonly options: WebhookInboundCleanupOptions,
  ) {}

  isEnabled(): boolean {
    const raw = this.configService
      .get<string>('WEBHOOK_INBOUND_CLEANUP_ENABLED')
      ?.trim()
      .toLowerCase();
    return raw !== 'false' && raw !== '0';
  }

  getRetentionDays(): number {
    const raw = this.configService
      .get<string>('WEBHOOK_INBOUND_RETENTION_DAYS')
      ?.trim();
    if (!raw) return DEFAULT_RETENTION_DAYS;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : DEFAULT_RETENTION_DAYS;
  }

  /** Purge terminal raw payloads — 03:15 ICT daily. */
  @Cron('0 15 3 * * *', {
    name: 'webhook-inbound-cleanup',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleCleanup(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    const retentionDays = this.getRetentionDays();
    const cutoff = subDays(new Date(), retentionDays);

    const result = await this.pgLock.withLock(this.options.lockId, async () => {
      const deleted = await this.inboundEvents.deleteTerminalOlderThan(cutoff);
      if (deleted > 0) {
        this.logger.log(
          `webhook-inbound-cleanup: deleted ${deleted} terminal row(s) older than ${retentionDays} day(s) (before ${cutoff.toISOString()})`,
        );
      }
      return deleted;
    });

    if (result === null) {
      this.logger.debug(
        'webhook-inbound-cleanup skipped — lock held by another pod',
      );
    }
  }
}
