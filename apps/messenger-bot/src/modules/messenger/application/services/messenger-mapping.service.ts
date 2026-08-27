import { Inject, Injectable, Logger } from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { MessengerLinkContext } from '@messenger/shared/config/poc.constants';
import {
  createSessionSourceGetSessions,
  StudyReminderSyncService,
} from '@wispace/study-reminder-shared';
import { StudySessionSourceService } from '@messenger/modules/study-reminder/application/services/study-session-source.service';
import { MESSENGER_REPOSITORY } from '../../domain/repositories/messenger.repository.port';
import type { MessengerMappingRepositoryPort } from '../../domain/repositories/messenger-mapping.repository.port';
import type { RelinkMappingResult } from '../types/messenger-mapping.types';
import {
  buildMappingUserIdRelinkedMessage,
  buildMappingRelinkBlockedMessage,
  buildMappingUserLinkedOtherPsidMessage,
} from '../messages/messenger-link.messages';
import { MessengerOutboundService } from './messenger-outbound.service';
import {
  CLARIFICATION_STATE_STORE,
  type ClarificationStateStore,
} from '@wispace/chat-agent';

@Injectable()
export class MessengerMappingService {
  private readonly logger = new Logger(MessengerMappingService.name);

  constructor(
    @Inject(MESSENGER_REPOSITORY)
    private readonly repository: MessengerMappingRepositoryPort,
    private readonly outbound: MessengerOutboundService,
    private readonly studyReminderSyncService: StudyReminderSyncService,
    private readonly sessionSourceService: StudySessionSourceService,
    @Inject(CLARIFICATION_STATE_STORE)
    private readonly clarificationStateStore: ClarificationStateStore,
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
    // ponytail: CAS guard closes PSID-direction race (same PSID, different
    // users). UserId-direction race (different PSIDs → same user) still open
    // — requires a partial unique index on (platform, user_id) WHERE ACTIVE
    // to close at the DB level. Accept ceiling for now; the pre-resolve check
    // in MessengerService catches the common case.
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
        `MAPPING_RELINK_BLOCKED psid=${maskExternalId(
          params.psid,
        )} from=${maskExternalId(previousUserId)} to=${maskExternalId(
          params.userId,
        )}`,
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
        `MAPPING_USER_PSID_CONFLICT userId=${maskExternalId(
          params.userId,
        )} existingPsid=${maskExternalId(
          existingByUserId.psid,
        )} newPsid=${maskExternalId(params.psid)}`,
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

    // #383: CAS guard may have blocked the upsert when a concurrent write
    // changed the userId — treat as a blocked relink attempt.
    if (!mapping) {
      this.logger.warn(
        `MAPPING_CAS_BLOCKED psid=${maskExternalId(
          params.psid,
        )} userId=${maskExternalId(String(params.userId))}`,
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

    await this.clearClarificationState(params.psid);

    if (relinked) {
      this.logger.warn(
        `MAPPING_USER_ID_RELINK psid=${maskExternalId(
          params.psid,
        )} from=${maskExternalId(previousUserId)} to=${maskExternalId(
          params.userId,
        )}`,
      );
    } else {
      this.logger.log(
        `Linked PSID ${maskExternalId(params.psid)} to userId=${maskExternalId(
          params.userId,
        )}, topic=${params.topic ?? mapping.topic}, cadence=${
          params.cadence ?? mapping.cadence
        }`,
      );
    }

    let syncedStudyReminders = false;
    if (params.syncStudyReminders !== false) {
      try {
        await this.studyReminderSyncService.syncUpcomingSessions({
          userId: params.userId,
          // Authoritative calendar fetch before any stale-job cancellation.
          getSessions: createSessionSourceGetSessions(
            this.sessionSourceService,
          ),
        });
        syncedStudyReminders = true;
      } catch (error) {
        this.logger.error(
          `Study reminder sync after relink failed userId=${maskExternalId(
            params.userId,
          )}`,
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

  private async clearClarificationState(psid: string): Promise<void> {
    try {
      await this.clarificationStateStore.clear(`messenger:${psid}`);
    } catch (error: unknown) {
      this.logger.warn(
        `Clarification state clear after mapping update failed psid=${maskExternalId(psid)}: ${errorMessage(error, psid)}`,
      );
    }
  }
}
