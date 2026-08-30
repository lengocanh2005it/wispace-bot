import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  errorMessage,
  maskExternalId,
  maskExternalIdInText,
} from '@wispace/bot-common/masking';
import type {
  ReportDeliveryPort,
  ReportDeliveryResult,
  ReportMapping,
} from '@wispace/scheduler-core';
import {
  DiscordDeliveryFailureError,
  DiscordOutboundService,
} from './discord-outbound.service';
import {
  DISCORD_REPORT_ACCOUNT_READER,
  type DiscordReportAccountPageReaderPort,
} from '../../domain/ports/discord-report-account-reader.port';

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
    @Inject(DISCORD_REPORT_ACCOUNT_READER)
    private readonly accountLinkReader: DiscordReportAccountPageReaderPort,
  ) {}

  async sendReport(input: {
    mapping: ReportMapping;
    reportText: string;
    reportDate: string;
    deliveryKey?: string;
  }): Promise<ReportDeliveryResult> {
    const { mapping, reportText, deliveryKey } = input;

    try {
      const hasLink =
        await this.accountLinkReader.findLinkStateByExternalUserId(
          mapping.externalUserId,
        );

      if (
        !hasLink ||
        (hasLink.linkState && hasLink.linkState !== 'active') ||
        (mapping.userId !== undefined && hasLink.userId !== mapping.userId)
      ) {
        this.logger.warn(
          `No Discord account link for externalUserId=${maskExternalId(
            mapping.externalUserId,
          )}`,
        );
        return { ok: false, reason: 'NOT_LINKED' };
      }

      const chunks = this.splitMessage(reportText);
      const nonce = deliveryKey
        ? deliveryKey.replace(/[^a-zA-Z0-9]/g, '').slice(0, 25)
        : undefined;
      for (const chunk of chunks) {
        const current =
          await this.accountLinkReader.findLinkStateByExternalUserId(
            mapping.externalUserId,
          );
        if (
          !current ||
          (current.linkState && current.linkState !== 'active') ||
          (mapping.userId !== undefined && current.userId !== mapping.userId)
        ) {
          this.logger.warn(
            `Discord link changed before report send externalUserId=${maskExternalId(
              mapping.externalUserId,
            )}`,
          );
          return { ok: false, reason: 'NOT_LINKED' };
        }
        await this.outboundService.sendText(mapping.externalUserId, chunk, {
          skipDeadLetter: true,
          nonce,
          retryOn: 'none',
        });
      }

      return { ok: true };
    } catch (error) {
      const msg = maskExternalIdInText(
        errorMessage(error),
        mapping.externalUserId,
      );
      this.logger.warn(
        `Failed to send report to externalUserId=${maskExternalId(
          mapping.externalUserId,
        )}: ${msg}`,
      );

      if (
        error instanceof DiscordDeliveryFailureError &&
        error.ambiguousDelivery
      ) {
        return { ok: true, outcome: 'ambiguous' };
      }
      if (error instanceof DiscordDeliveryFailureError && error.retryable) {
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
