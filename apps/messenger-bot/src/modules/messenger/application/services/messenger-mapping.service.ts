import { Inject, Injectable, Logger } from '@nestjs/common';
import { MessengerLinkContext } from '@messenger/shared/config/poc.constants';
import { StudyReminderSyncService } from '@wispace/study-reminder-shared';
import { MESSENGER_REPOSITORY } from '../../domain/repositories/messenger.repository.port';
import type { MessengerMappingRepositoryPort } from '../../domain/repositories/messenger-mapping.repository.port';
import type { RelinkMappingResult } from '../types/messenger-mapping.types';
import {
  buildMappingUserIdRelinkedMessage,
  buildMappingRelinkBlockedMessage,
  buildMappingUserLinkedOtherPsidMessage,
} from '../messages/messenger-link.messages';
import { MessengerOutboundService } from './messenger-outbound.service';

@Injectable()
export class MessengerMappingService {
  private readonly logger = new Logger(MessengerMappingService.name);

  constructor(
    @Inject(MESSENGER_REPOSITORY)
    private readonly repository: MessengerMappingRepositoryPort,
    private readonly outbound: MessengerOutboundService,
    private readonly studyReminderSyncService: StudyReminderSyncService,
  ) {}

  async linkFromContext(
    psid: string,
    context: MessengerLinkContext,
    options?: {
      notifyUser?: boolean;
      syncStudyReminders?: boolean;
      allowRelink?: boolean;
    },
  ): Promise<RelinkMappingResult> {
    return this.relinkPsidToUserId({
      psid,
      userId: context.userId,
      topic: context.topic,
      cadence: context.cadence,
      notifyUser: options?.notifyUser ?? true,
      syncStudyReminders: options?.syncStudyReminders ?? true,
      allowRelink: options?.allowRelink ?? false,
    });
  }

  async relinkPsidToUserId(params: {
    psid: string;
    userId: number;
    topic?: string;
    cadence?: MessengerLinkContext['cadence'];
    notifyUser?: boolean;
    syncStudyReminders?: boolean;
    allowRelink?: boolean;
  }): Promise<RelinkMappingResult> {
    const existingByPsid = await this.repository.findActiveMappingByPsid(
      params.psid,
    );
    const existingByUserId = await this.repository.findActiveMappingByUserId(
      params.userId,
    );
    const previousUserId = existingByPsid?.userId;
    const relinked = previousUserId != null && previousUserId !== params.userId;
    const userLinkedOtherPsid =
      existingByUserId?.psid != null && existingByUserId.psid !== params.psid;

    if (relinked && !params.allowRelink) {
      this.logger.warn(
        `MAPPING_RELINK_BLOCKED psid=${params.psid} from=${previousUserId} to=${params.userId}`,
      );

      if (params.notifyUser !== false) {
        await this.outbound.sendTextViaPsid({
          psid: params.psid,
          userId: previousUserId ?? undefined,
          text: buildMappingRelinkBlockedMessage(),
          messageType: 'MAPPING_RELINK_BLOCKED',
        });
      }

      return {
        mapping: existingByPsid!,
        relinked: false,
        blocked: true,
        previousUserId,
        syncedStudyReminders: false,
      };
    }

    if (userLinkedOtherPsid && !params.allowRelink) {
      this.logger.warn(
        `MAPPING_USER_PSID_CONFLICT userId=${params.userId} existingPsid=${existingByUserId.psid} newPsid=${params.psid}`,
      );

      if (params.notifyUser !== false) {
        await this.outbound.sendTextViaPsid({
          psid: params.psid,
          text: buildMappingUserLinkedOtherPsidMessage(),
          messageType: 'MAPPING_USER_PSID_CONFLICT',
        });
      }

      return {
        mapping: existingByUserId,
        relinked: false,
        blocked: true,
        previousUserId,
        syncedStudyReminders: false,
      };
    }

    if (params.allowRelink) {
      await this.repository.deactivateConflictingActiveMappings({
        psid: params.psid,
        userId: params.userId,
      });
    }

    const mapping = await this.repository.upsertPsidUserLink({
      psid: params.psid,
      userId: params.userId,
      topic: params.topic,
      cadence: params.cadence,
    });

    if (relinked) {
      this.logger.warn(
        `MAPPING_USER_ID_RELINK psid=${params.psid} from=${previousUserId} to=${params.userId}`,
      );
    } else {
      this.logger.log(
        `Linked PSID ${params.psid} to userId=${params.userId}, topic=${params.topic ?? mapping.topic}, cadence=${params.cadence ?? mapping.cadence}`,
      );
    }

    let syncedStudyReminders = false;
    if (params.syncStudyReminders !== false) {
      try {
        await this.studyReminderSyncService.syncUpcomingSessions({
          userId: params.userId,
        });
        syncedStudyReminders = true;
      } catch (error) {
        this.logger.error(
          `Study reminder sync after relink failed userId=${params.userId}`,
          error,
        );
      }
    }

    if (relinked && params.notifyUser !== false) {
      await this.outbound.sendTextViaPsid({
        psid: params.psid,
        userId: params.userId,
        text: buildMappingUserIdRelinkedMessage(params.userId),
        messageType: 'MAPPING_USER_ID_UPDATED',
      });
    }

    return {
      mapping,
      relinked,
      previousUserId,
      syncedStudyReminders,
    };
  }
}
