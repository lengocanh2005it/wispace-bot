import { Injectable, Logger } from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type {
  ReportDeliveryPort,
  ReportDeliveryResult,
  ReportMapping,
} from '@wispace/scheduler-core';
import { DiscordOutboundService } from './discord-outbound.service';
import { DiscordAccountLinkEntity } from '@discord/infrastructure/database/entities/discord-account-link.entity';

const PLATFORM = 'discord' as const;

const DISCORD_MAX_MESSAGE_LENGTH = 2000;

/**
 * Discord implementation of ReportDeliveryPort — sends reports via DM.
 * No 24h window limit like Messenger.
 */
@Injectable()
export class DiscordReportDeliveryService implements ReportDeliveryPort {
  private readonly logger = new Logger(DiscordReportDeliveryService.name);

  constructor(
    private readonly outboundService: DiscordOutboundService,
    @InjectRepository(DiscordAccountLinkEntity)
    private readonly accountLinkRepo: Repository<DiscordAccountLinkEntity>,
  ) {}

  async sendReport(input: {
    mapping: ReportMapping;
    reportText: string;
    reportDate: string;
  }): Promise<ReportDeliveryResult> {
    const { mapping, reportText } = input;

    try {
      const hasLink = await this.accountLinkRepo.findOne({
        where: {
          platform: PLATFORM,
          externalUserId: mapping.externalUserId,
        },
        select: { id: true },
      });

      if (!hasLink) {
        this.logger.warn(
          `No Discord account link for externalUserId=${mapping.externalUserId}`,
        );
        return { ok: false, reason: 'NOT_LINKED' };
      }

      const chunks = this.splitMessage(reportText);
      for (const chunk of chunks) {
        await this.outboundService.sendText(mapping.externalUserId, chunk);
      }

      return { ok: true };
    } catch (error) {
      const msg = errorMessage(error);
      this.logger.warn(
        `Failed to send report to externalUserId=${mapping.externalUserId}: ${msg}`,
      );

      if (msg.includes('429') || msg.includes('rate limit')) {
        return { ok: false, reason: 'RETRYABLE' };
      }
      return { ok: false, reason: 'DELIVERY_FAILED' };
    }
  }

  private splitMessage(text: string): string[] {
    if (text.length <= DISCORD_MAX_MESSAGE_LENGTH) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= DISCORD_MAX_MESSAGE_LENGTH) {
        chunks.push(remaining);
        break;
      }

      let splitIndex = remaining.lastIndexOf('\n', DISCORD_MAX_MESSAGE_LENGTH);
      if (splitIndex <= 0) {
        splitIndex = DISCORD_MAX_MESSAGE_LENGTH;
      }

      chunks.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex).trimStart();
    }

    return chunks;
  }
}
