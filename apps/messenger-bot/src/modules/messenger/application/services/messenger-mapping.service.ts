import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Counter } from 'prom-client';
import {
  errorMessage,
  maskExternalId,
  maskExternalIdInText,
} from '@wispace/bot-common/masking';
import { MessengerLinkContext } from '@messenger/shared/config/poc.constants';
import type { UserMessengerMapping } from '@messenger/modules/messenger/domain/entities/messenger.types';
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
import {
  PlatformLinkStateService,
  NotificationPreferenceService,
} from '@wispace/database';
import { buildConsentExplainerMessage } from '@wispace/bot-common/messages';
import {
  MESSENGER_LINK_VERIFY_RECORD_REPOSITORY,
  MESSENGER_LINK_INTENT_LEASE_MS,
  type MessengerLinkVerifyRecordRepositoryPort,
} from '../../domain/ports/messenger-link-verify-record.repository.port';

const LINK_INTENT_MAX_HEARTBEAT_MS = MESSENGER_LINK_INTENT_LEASE_MS * 5;

const linkCompletionTotal = new Counter({
  name: 'messenger_link_completion_total',
  help: 'Messenger link completion outcomes',
  labelNames: ['outcome'] as const,
});

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
    private readonly notificationPreferences: NotificationPreferenceService,
    @Optional() private readonly linkState?: PlatformLinkStateService,
    @Optional()
    @Inject(MESSENGER_LINK_VERIFY_RECORD_REPOSITORY)
    private readonly verifyRecordRepository?: MessengerLinkVerifyRecordRepositoryPort,
  ) {}

  async linkFromContext(
    psid: string,
    context: MessengerLinkContext,
    options?: {
      notifyUser?: boolean;
      syncStudyReminders?: boolean;
      allowRelink?: boolean;
      intentGeneration?: string;
      intentLeaseToken?: string;
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
      intentGeneration: options?.intentGeneration,
      intentLeaseToken: options?.intentLeaseToken,
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
    intentGeneration?: string;
    intentLeaseToken?: string;
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
          userId: params.userId,
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

    let intentLeaseToken: string | undefined;
    if (params.intentGeneration && this.verifyRecordRepository) {
      let claimResult;
      try {
        claimResult = await this.verifyRecordRepository.claimRecord({
          psid: params.psid,
          userId: params.userId,
          intentGeneration: params.intentGeneration,
          leaseMs: MESSENGER_LINK_INTENT_LEASE_MS,
          ...(params.intentLeaseToken
            ? { leaseToken: params.intentLeaseToken }
            : {}),
        });
      } catch (error) {
        linkCompletionTotal.inc({ outcome: 'claim_failed' });
        this.logger.warn(
          `Messenger link intent claim failed psid=${maskExternalId(
            params.psid,
          )}: ${maskExternalIdInText(errorMessage(error), params.psid)}`,
        );

        return {
          mapping: existingByPsid ?? undefined,
          relinked,
          blocked: true,
          intentOutcome: 'claim_failed',
          previousUserId,
          syncedStudyReminders: false,
        };
      }

      if (claimResult.status === 'already_processing') {
        linkCompletionTotal.inc({ outcome: 'already_processing' });
        return {
          mapping: existingByPsid ?? undefined,
          relinked,
          blocked: true,
          intentOutcome: 'already_processing',
          previousUserId,
          syncedStudyReminders: false,
        };
      }
      if (claimResult.status === 'already_committed') {
        linkCompletionTotal.inc({ outcome: 'already_committed' });
        return {
          mapping: existingByPsid ?? undefined,
          relinked,
          blocked: true,
          intentOutcome: 'already_committed',
          previousUserId,
          syncedStudyReminders: false,
        };
      }
      if (claimResult.status === 'not_found') {
        linkCompletionTotal.inc({ outcome: 'stale' });
        this.logger.warn(
          `Messenger link intent generation no longer current psid=${maskExternalId(
            params.psid,
          )} userId=${maskExternalId(String(params.userId))}`,
        );
        return {
          mapping: existingByPsid ?? undefined,
          relinked,
          blocked: true,
          intentOutcome: 'stale',
          previousUserId,
          syncedStudyReminders: false,
        };
      }

      if (claimResult.status !== 'claimed') {
        linkCompletionTotal.inc({ outcome: 'stale' });
        return {
          mapping: existingByPsid ?? undefined,
          relinked,
          blocked: true,
          intentOutcome: 'stale',
          previousUserId,
          syncedStudyReminders: false,
        };
      }

      intentLeaseToken = claimResult.leaseToken;
      linkCompletionTotal.inc({ outcome: 'claimed' });
    }

    const stopLeaseHeartbeat = this.startIntentLeaseHeartbeat(
      params,
      intentLeaseToken,
    );
    try {
      if (params.allowRelink) {
        await this.repository.deactivateConflictingActiveMappings({
          psid: params.psid,
          userId: params.userId,
        });
      }

      const observedLink = await this.linkState?.getLink(
        'messenger',
        params.psid,
      );
      const mapping = await this.repository.upsertPsidUserLink({
        psid: params.psid,
        userId: params.userId,
        topic: params.topic,
        cadence: params.cadence,
        ...(observedLink?.generation
          ? { expectedGeneration: observedLink.generation }
          : {}),
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
          mapping: existingByPsid ?? undefined,
          relinked: false,
          blocked: true,
          previousUserId,
          syncedStudyReminders: false,
        };
      }

      const syncedStudyReminders = await this.runLinkDataSideEffects(params);

      if (intentLeaseToken && this.verifyRecordRepository) {
        let completeResult: 'committed' | 'already_committed' | 'not_found';
        try {
          completeResult = await this.verifyRecordRepository.completeRecord({
            psid: params.psid,
            userId: params.userId,
            intentGeneration: params.intentGeneration!,
            leaseToken: intentLeaseToken,
          });
        } catch (error) {
          linkCompletionTotal.inc({ outcome: 'complete_failed' });
          this.logger.warn(
            `Messenger link intent completion failed psid=${maskExternalId(
              params.psid,
            )}: ${maskExternalIdInText(errorMessage(error), params.psid)}`,
          );
          return {
            mapping,
            relinked,
            blocked: true,
            intentOutcome: 'complete_failed',
            previousUserId,
            syncedStudyReminders,
          };
        }

        if (completeResult !== 'committed') {
          linkCompletionTotal.inc({
            outcome:
              completeResult === 'already_committed'
                ? 'already_committed'
                : 'stale',
          });
          return {
            mapping,
            relinked,
            blocked: true,
            intentOutcome:
              completeResult === 'already_committed'
                ? 'already_committed'
                : 'stale',
            previousUserId,
            syncedStudyReminders,
          };
        }

        linkCompletionTotal.inc({ outcome: 'committed' });
      }

      this.logLinkCommitted(params, mapping, relinked, previousUserId);
      await this.sendLinkCompletionNotices(params, relinked);

      return {
        mapping,
        relinked,
        previousUserId,
        syncedStudyReminders,
      };
    } finally {
      await stopLeaseHeartbeat?.();
    }
  }

  private startIntentLeaseHeartbeat(
    params: { psid: string; userId: number; intentGeneration?: string },
    leaseToken?: string,
  ): (() => Promise<void>) | undefined {
    const renewRecord = this.verifyRecordRepository?.renewRecord;
    if (!renewRecord || !leaseToken || !params.intentGeneration) {
      return undefined;
    }

    let stopped = false;
    let inFlight: Promise<void> | undefined;
    const renew = (): void => {
      if (stopped || inFlight) return;

      inFlight = Promise.resolve()
        .then(() =>
          renewRecord({
            psid: params.psid,
            userId: params.userId,
            intentGeneration: params.intentGeneration!,
            leaseToken,
            leaseMs: MESSENGER_LINK_INTENT_LEASE_MS,
          }),
        )
        .then((renewed) => {
          if (!renewed) {
            linkCompletionTotal.inc({ outcome: 'lease_renew_lost' });
            this.logger.warn(
              `Messenger link intent lease renewal lost psid=${maskExternalId(
                params.psid,
              )}`,
            );
          }
        })
        .catch((error: unknown) => {
          linkCompletionTotal.inc({ outcome: 'lease_renew_failed' });
          this.logger.warn(
            `Messenger link intent lease renewal failed psid=${maskExternalId(
              params.psid,
            )}: ${maskExternalIdInText(errorMessage(error), params.psid)}`,
          );
        })
        .finally(() => {
          inFlight = undefined;
        });
    };

    const interval = setInterval(
      renew,
      Math.floor(MESSENGER_LINK_INTENT_LEASE_MS / 3),
    );
    const maxDuration = setTimeout(() => {
      stopped = true;
      clearInterval(interval);
      this.logger.warn(
        `Messenger link intent lease heartbeat ceiling reached psid=${maskExternalId(
          params.psid,
        )}`,
      );
    }, LINK_INTENT_MAX_HEARTBEAT_MS);

    return async () => {
      stopped = true;
      clearInterval(interval);
      clearTimeout(maxDuration);
      await inFlight;
    };
  }

  private async runLinkDataSideEffects(params: {
    psid: string;
    userId: number;
    topic?: string;
    cadence?: MessengerLinkContext['cadence'];
    syncStudyReminders?: boolean;
  }): Promise<boolean> {
    await this.clearClarificationState(params.psid);

    // Consent write-sync (#596): a link that carries cadence+topic IS a report
    // subscription (opt-in event / register_report / referral with defaults).
    if (params.topic && params.cadence) {
      await this.notificationPreferences
        .setReportEnabled(params.userId, true)
        .catch((error: unknown) => {
          this.logger.warn(
            `Report consent write-sync failed userId=${maskExternalId(
              String(params.userId),
            )}: ${errorMessage(error)}`,
          );
        });
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

    return syncedStudyReminders;
  }

  private logLinkCommitted(
    params: {
      psid: string;
      userId: number;
      topic?: string;
      cadence?: MessengerLinkContext['cadence'];
    },
    mapping: UserMessengerMapping,
    relinked: boolean,
    previousUserId?: number,
  ): void {
    if (relinked) {
      this.logger.warn(
        `MAPPING_USER_ID_RELINK psid=${maskExternalId(
          params.psid,
        )} from=${maskExternalId(previousUserId)} to=${maskExternalId(
          params.userId,
        )}`,
      );
      return;
    }

    this.logger.log(
      `Linked PSID ${maskExternalId(params.psid)} to userId=${maskExternalId(
        params.userId,
      )}, topic=${params.topic ?? mapping.topic}, cadence=${
        params.cadence ?? mapping.cadence
      }`,
    );
  }

  private async sendLinkCompletionNotices(
    params: {
      psid: string;
      userId: number;
      topic?: string;
      cadence?: MessengerLinkContext['cadence'];
      notifyUser?: boolean;
    },
    relinked: boolean,
  ): Promise<void> {
    if (params.notifyUser === false) return;

    if (!params.topic || !params.cadence) {
      // Linked without a report subscription — one explainer so the learner
      // knows reports/reminders exist and how to toggle them (#596).
      await this.outbound
        .sendTextViaPsid({
          psid: params.psid,
          userId: params.userId,
          text: buildConsentExplainerMessage(),
          messageType: 'CONSENT_EXPLAINER',
        })
        .catch(() => undefined);
    }

    if (relinked) {
      await this.outbound.sendTextViaPsid({
        psid: params.psid,
        userId: params.userId,
        text: buildMappingUserIdRelinkedMessage(params.userId),
        messageType: 'MAPPING_USER_ID_UPDATED',
      });
    }
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
