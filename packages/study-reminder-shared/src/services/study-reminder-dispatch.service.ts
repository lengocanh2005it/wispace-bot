import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { jitteredDelayMs } from '@wispace/bot-common/utils';
import type { OutboundDeliveryOutcome, Platform } from '@wispace/contracts';
import {
  STUDY_REMINDER_JOB_REPOSITORY,
  type StudyReminderJobRepositoryPort,
} from '../ports/study-reminder-job.repository.port';
import {
  MESSAGE_SENDER,
  type MessageSenderPort,
} from '../ports/message-sender.port';
import {
  DISPATCH_HOOKS,
  type DispatchHooksPort,
} from '../ports/dispatch-hooks.port';
import { StudyReminderScheduleService } from './study-reminder-schedule.service';
import { subMilliseconds } from 'date-fns';
import type {
  StudyReminderJob,
  StudyReminderMappingState,
} from '../types/study-reminder.types';

/**
 * Cancellation reason for a reminder suppressed by the web-activity dormancy
 * gate. Single source of truth — written to study_reminder_jobs, matched by the
 * per-bot DISPATCH_HOOKS to meter suppression.
 */
export const DORMANT_REASON = 'recipient dormant (web inactivity)';

export interface StudyReminderDispatchFailure {
  jobId: number;
  externalUserId: string;
  error: string;
}

export interface StudyReminderDispatchResult {
  claimed: number;
  sent: number;
  cancelled: number;
  retried: number;
  failed: number;
  resetStuck: number;
  nextDueAt: Date | null;
  failures: StudyReminderDispatchFailure[];
}

export interface StudyReminderDispatchServiceOptions {
  /** Producer-side cap derived from the local LLM admission capacity (#1363). */
  concurrencyLimit: number;
  /** Re-check ownership after claiming and immediately before any send. */
  getMappingState?: (
    externalUserId: string,
  ) => Promise<
    | StudyReminderMappingState
    | 'active'
    | 'confirmed-revoked'
    | 'temporarily-unknown'
    | 'locally-unlinked'
    | null
  >;
  /**
   * 'exponential' (default): backoff grows 2^retryCount.
   * 'flat' (Messenger): fixed retryBackoffMinutes between attempts.
   */
  backoffMode?: 'exponential' | 'flat';
  /**
   * Messenger: batch display-name warm-up before dispatching (single query
   * instead of N lazy DB reads). Errors are logged and ignored.
   */
  preloadDisplayNames?: (userIds: number[]) => Promise<void>;
  /**
   * Returns the dormant subset of the numeric userIds collected from due jobs.
   * Called once per run after preloadDisplayNames. A dormant recipient's claimed
   * job is cancelled with reason 'recipient dormant (web inactivity)'. Errors
   * are logged and ignored (fail-open: nobody suppressed).
   */
  filterDormantUserIds?: (userIds: number[]) => Promise<number[]>;
  /**
   * Messenger: classifies a send failure as terminal (24h window, non-retryable
   * Wispace error) and normalizes the persisted error message. When it returns
   * a value, it fully overrides the default classification.
   */
  classifyFailure?: (params: {
    error: unknown;
    job: StudyReminderJob;
  }) => { terminal: boolean; errorMessage: string } | undefined;
  /**
   * Injectable RNG for the equal-jitter applied to `next_retry_at` — spreads
   * a batch of jobs that failed on the same upstream error so their retries do
   * not all become due in the same tick. Tests pass a stub; production leaves
   * it undefined (`Math.random`).
   */
  rng?: () => number;
}

@Injectable()
export class StudyReminderDispatchService {
  private readonly logger = new Logger(StudyReminderDispatchService.name);

  constructor(
    @Inject(STUDY_REMINDER_JOB_REPOSITORY)
    private readonly jobRepository: StudyReminderJobRepositoryPort,
    @Inject(MESSAGE_SENDER)
    private readonly messageSender: MessageSenderPort,
    private readonly scheduleService: StudyReminderScheduleService,
    /** The worker's own platform — every due/claim/reset query is scoped to it (#180). */
    private readonly platform: Platform,
    @Optional()
    @Inject(DISPATCH_HOOKS)
    private readonly hooks: DispatchHooksPort | undefined,
    private readonly options: StudyReminderDispatchServiceOptions,
  ) {}

  async dispatchDueReminders(): Promise<StudyReminderDispatchResult> {
    const settings = this.scheduleService.getOutboxSettings();
    const now = new Date();

    const resetStuck = await this.jobRepository.resetStuckProcessingJobs(
      this.platform,
      subMilliseconds(now, settings.stuckProcessingMs),
    );

    const dueJobs = await this.jobRepository.findDueJobs(
      this.platform,
      now,
      settings.minLeadMinutes,
    );

    // Pre-fetch display names in a single batch query to avoid N lazy DB reads.
    const uniqueUserIds = [
      ...new Set(
        dueJobs.map((j) => j.userId).filter((id): id is number => !!id),
      ),
    ];
    if (uniqueUserIds.length > 0 && this.options?.preloadDisplayNames) {
      try {
        await this.options.preloadDisplayNames(uniqueUserIds);
      } catch (error) {
        this.logger.warn(
          `Display name preload failed, continuing with lazy fallback: ${errorMessage(error)}`,
        );
      }
    }

    let dormantUserIds = new Set<number>();
    if (uniqueUserIds.length > 0 && this.options?.filterDormantUserIds) {
      try {
        dormantUserIds = new Set(
          await this.options.filterDormantUserIds(uniqueUserIds),
        );
      } catch (error) {
        this.logger.warn(
          `Dormancy filter failed, no recipients suppressed: ${errorMessage(error)}`,
        );
      }
    }

    let claimed = 0;
    let sent = 0;
    let cancelled = 0;
    let retried = 0;
    let failed = 0;
    const failures: StudyReminderDispatchFailure[] = [];

    const concurrencyLimit = this.options.concurrencyLimit;
    const processJob = async (job: StudyReminderJob) => {
      const claimedJob = await this.jobRepository.claimJob(
        this.platform,
        job.id,
        settings.leaseMs,
      );
      if (!claimedJob) return;

      claimed += 1;
      const leaseToken = claimedJob.leaseToken ?? '';
      const cancelForFence = async (reason: string): Promise<boolean> => {
        await this.jobRepository.markCancelled(
          claimedJob.id,
          leaseToken,
          reason,
        );
        this.hooks?.onCancelled?.({
          jobId: claimedJob.id,
          externalUserId: claimedJob.externalUserId,
          reason,
        });
        cancelled += 1;
        return false;
      };
      const checkMappingBeforeSend = async (): Promise<boolean> => {
        if (!this.options?.getMappingState) return true;
        const mapping = await this.options.getMappingState(
          claimedJob.externalUserId,
        );
        const state = typeof mapping === 'string' ? mapping : mapping?.state;
        if (state === 'active') {
          const owner = typeof mapping === 'string' ? undefined : mapping;
          if (
            claimedJob.userId == null ||
            !claimedJob.mappingGeneration ||
            !owner?.userId ||
            !owner.mappingGeneration
          ) {
            return cancelForFence('mapping_generation_missing');
          }
          if (
            owner.userId !== claimedJob.userId ||
            owner.mappingGeneration !== claimedJob.mappingGeneration
          ) {
            return cancelForFence('mapping_ownership_changed');
          }
          return true;
        }
        if (state === 'confirmed-revoked') {
          return cancelForFence('link_revoked');
        }
        if (state === 'locally-unlinked') {
          return cancelForFence('locally_unlinked');
        }
        // A deleted mapping may have only a hash tombstone. Let the
        // repository's authoritative fence resolve that tombstone; it also
        // distinguishes a missing tombstone (retryable unknown).
        if (mapping === null && this.jobRepository.withOwnedDelivery) {
          return true;
        }
        // Unknown/no-row is retried through the normal bounded failure path;
        // never turn an upstream outage into permanent data loss.
        throw new Error(`link status unavailable (${state ?? 'missing'})`);
      };

      // Defensive guard for alternate/legacy repositories: the TypeORM claim
      // predicate already excludes these outcomes, but a claimed terminal row
      // must never reach the provider (#294).
      if (
        claimedJob.deliveryStatus === 'ambiguous' ||
        claimedJob.deliveryStatus === 'rate_limited'
      ) {
        const outcomeError =
          claimedJob.deliveryStatus === 'ambiguous'
            ? 'ambiguous delivery — not auto-retried'
            : 'outbound_rate_limited';
        this.logger.warn(
          `Study reminder job re-claimed with terminal delivery status=${claimedJob.deliveryStatus} jobId=${claimedJob.id} externalUserId=${maskExternalId(
            claimedJob.externalUserId,
          )} — skipping, ops review needed`,
        );
        try {
          await this.jobRepository.markFailed({
            jobId: claimedJob.id,
            leaseToken,
            errorMessage: outcomeError,
            retryCount: Math.max(
              claimedJob.retryCount + 1,
              claimedJob.maxRetries,
            ),
            terminal: true,
            deliveryStatus: claimedJob.deliveryStatus,
          });
        } catch (error) {
          this.logger.error(
            `Failed to close reclaimed terminal reminder jobId=${claimedJob.id}: ${this.toErrorMessage(error)}`,
          );
        }
        this.hooks?.onFailed?.({
          jobId: claimedJob.id,
          externalUserId: claimedJob.externalUserId,
          error: outcomeError,
        });
        failures.push({
          jobId: claimedJob.id,
          externalUserId: claimedJob.externalUserId,
          error: outcomeError,
        });
        failed += 1;
        return;
      }

      // Defensive guard for alternate/legacy repositories. The TypeORM claim
      // predicate excludes these rows, but a claimed delivery marker is still
      // authoritative and must never be sent twice (#181).
      if (claimedJob.deliveryStatus === 'sent' || claimedJob.deliveryRecord) {
        const finalized = await this.jobRepository.markSent(
          claimedJob.id,
          leaseToken,
        );
        if (!finalized) return;
        this.hooks?.onSent?.({
          jobId: claimedJob.id,
          externalUserId: claimedJob.externalUserId,
        });
        sent += 1;
        return;
      }

      try {
        if (!(await checkMappingBeforeSend())) return;

        if (
          claimedJob.userId != null &&
          dormantUserIds.has(claimedJob.userId)
        ) {
          await this.jobRepository.markCancelled(
            claimedJob.id,
            leaseToken,
            DORMANT_REASON,
          );
          this.hooks?.onCancelled?.({
            jobId: claimedJob.id,
            externalUserId: claimedJob.externalUserId,
            reason: DORMANT_REASON,
          });
          cancelled += 1;
          return;
        }

        if (
          this.scheduleService.isSessionStarted(claimedJob.scheduledAt, now)
        ) {
          await this.jobRepository.markCancelled(
            claimedJob.id,
            leaseToken,
            'session already started',
          );
          this.hooks?.onCancelled?.({
            jobId: claimedJob.id,
            externalUserId: claimedJob.externalUserId,
            reason: 'session already started',
          });
          cancelled += 1;
          return;
        }

        const timeLabel = this.scheduleService.formatScheduledTimeLabel(
          claimedJob.scheduledAt,
        );
        const minutesUntil = this.scheduleService.getMinutesUntilSession(
          claimedJob.scheduledAt,
          now,
        );

        const text = await this.buildReminderText(
          claimedJob,
          timeLabel,
          minutesUntil,
        );

        // Do not persist a key for a revoked mapping. This preflight is a cheap
        // fail-fast check; the repository fence below is authoritative and
        // holds the mapping lock through the provider call.
        if (!(await checkMappingBeforeSend())) return;

        // Stable delivery key — persisted before calling the provider so that
        // a crash after send but before markSent leaves a recoverable record
        // (#294).
        const deliveryKey =
          claimedJob.deliveryKey ?? `reminder:${claimedJob.id}:${randomUUID()}`;
        let outcome: OutboundDeliveryOutcome;
        let sendError: unknown;
        let providerOutcome: OutboundDeliveryOutcome | undefined;
        const send = async (): Promise<{
          outcome: OutboundDeliveryOutcome;
          error?: unknown;
        }> => {
          try {
            const result = await this.messageSender.sendText({
              externalUserId: claimedJob.externalUserId,
              text,
              messageType: 'STUDY_REMINDER',
              userId: claimedJob.userId,
              deliveryKey,
            });
            providerOutcome = result;
            return { outcome: result };
          } catch (error) {
            return { outcome: 'not_sent', error };
          }
        };

        if (this.jobRepository.withOwnedDelivery) {
          if (claimedJob.userId == null || !claimedJob.mappingGeneration) {
            await cancelForFence('mapping_generation_missing');
            return;
          }
          let fenced:
            | { authorized: false; reason: string }
            | {
                authorized: true;
                value: { outcome: OutboundDeliveryOutcome; error?: unknown };
              };
          try {
            fenced = await this.jobRepository.withOwnedDelivery(
              {
                platform: this.platform,
                jobId: claimedJob.id,
                leaseToken,
                externalUserId: claimedJob.externalUserId,
                userId: claimedJob.userId,
                mappingGeneration: claimedJob.mappingGeneration,
                deliveryKey,
                // Provider timeout is shorter than the normal lease; leave a
                // bounded margin for finalization before recovery can reclaim.
                lockTimeoutMs: Math.max(1, Math.floor(settings.leaseMs / 2)),
              },
              send,
            );
          } catch (error) {
            // If the provider acknowledged inside the transaction but the
            // ownership/key transaction could not commit, retrying is unsafe.
            if (providerOutcome && providerOutcome !== 'not_sent') {
              const terminalError =
                providerOutcome === 'ambiguous'
                  ? 'ambiguous delivery — ownership finalization failed'
                  : providerOutcome === 'rate_limited'
                    ? 'outbound_rate_limited'
                    : `delivery acknowledged but ownership finalization failed: ${this.toErrorMessage(error)}`;
              const persistedTerminalError = errorMessage(terminalError, {
                externalUserId: claimedJob.externalUserId,
              });
              try {
                await this.jobRepository.markFailed({
                  jobId: claimedJob.id,
                  leaseToken,
                  errorMessage: persistedTerminalError,
                  retryCount: Math.max(
                    claimedJob.retryCount + 1,
                    claimedJob.maxRetries,
                  ),
                  terminal: true,
                  deliveryStatus: providerOutcome,
                });
              } catch (markError) {
                this.logger.error(
                  `Failed to persist ownership-finalization outcome jobId=${claimedJob.id}: ${this.toErrorMessage(markError)}`,
                );
              }
              this.hooks?.onFailed?.({
                jobId: claimedJob.id,
                externalUserId: claimedJob.externalUserId,
                error: persistedTerminalError,
              });
              failures.push({
                jobId: claimedJob.id,
                externalUserId: claimedJob.externalUserId,
                error: persistedTerminalError,
              });
              failed += 1;
              return;
            }
            throw error;
          }
          if (!fenced.authorized) {
            if (
              fenced.reason === 'mapping_ownership_changed' ||
              fenced.reason === 'mapping_generation_missing' ||
              fenced.reason === 'link_revoked' ||
              fenced.reason === 'locally_unlinked'
            ) {
              await cancelForFence(fenced.reason);
              return;
            }
            if (fenced.reason === 'lease_lost') return;
            throw new Error(`mapping fence unavailable (${fenced.reason})`);
          }
          outcome = fenced.value.outcome;
          sendError = fenced.value.error;
        } else {
          const ownsDeliveryLease = await this.jobRepository.markDeliveryKey(
            claimedJob.id,
            leaseToken,
            deliveryKey,
          );
          if (!ownsDeliveryLease) return;
          const sent = await send();
          outcome = sent.outcome;
          sendError = sent.error;
        }

        if (outcome === 'sent') {
          try {
            const finalized = await this.jobRepository.markSent(
              claimedJob.id,
              leaseToken,
              'sent',
              deliveryKey,
            );
            if (!finalized) return;
          } catch (error) {
            // The provider has acknowledged the message; a DB finalization
            // failure is ambiguous and must never become a blind retry.
            const finalizationError = `delivery acknowledged but finalization failed: ${this.toErrorMessage(error)}`;
            const persistedFinalizationError = errorMessage(finalizationError, {
              externalUserId: claimedJob.externalUserId,
            });
            try {
              await this.jobRepository.markFailed({
                jobId: claimedJob.id,
                leaseToken,
                errorMessage: persistedFinalizationError,
                retryCount: claimedJob.retryCount + 1,
                terminal: true,
                deliveryStatus: 'ambiguous',
              });
            } catch (markError) {
              this.logger.error(
                `Failed to persist ambiguous reminder finalization jobId=${claimedJob.id}: ${this.toErrorMessage(markError)}`,
              );
            }
            this.hooks?.onFailed?.({
              jobId: claimedJob.id,
              externalUserId: claimedJob.externalUserId,
              error: persistedFinalizationError,
            });
            failures.push({
              jobId: claimedJob.id,
              externalUserId: claimedJob.externalUserId,
              error: persistedFinalizationError,
            });
            failed += 1;
            return;
          }
          this.hooks?.onSent?.({
            jobId: claimedJob.id,
            externalUserId: claimedJob.externalUserId,
          });
          sent += 1;
        } else if (outcome === 'rate_limited' || outcome === 'ambiguous') {
          // Both outcomes are terminal. Keep persistence failures out of the
          // normal not_sent retry path: recovery will fail closed as ambiguous
          // if this worker cannot clear the processing lease.
          const terminalError =
            outcome === 'ambiguous'
              ? 'ambiguous delivery — not auto-retried'
              : 'outbound_rate_limited';
          try {
            await this.jobRepository.markFailed({
              jobId: claimedJob.id,
              leaseToken,
              errorMessage: terminalError,
              retryCount: claimedJob.retryCount + 1,
              terminal: true,
              deliveryStatus: outcome,
            });
          } catch (error) {
            this.logger.error(
              `Failed to persist terminal reminder outcome=${outcome} jobId=${claimedJob.id}: ${this.toErrorMessage(error)}`,
            );
          }
          this.hooks?.onFailed?.({
            jobId: claimedJob.id,
            externalUserId: claimedJob.externalUserId,
            error: terminalError,
          });
          failures.push({
            jobId: claimedJob.id,
            externalUserId: claimedJob.externalUserId,
            error: terminalError,
          });
          if (outcome === 'ambiguous') {
            this.logger.warn(
              `Study reminder job ambiguous delivery jobId=${claimedJob.id} externalUserId=${maskExternalId(
                claimedJob.externalUserId,
              )} — terminal, not auto-retried`,
            );
          }
          failed += 1;
        } else {
          // not_sent — throw so the outer catch block applies existing
          // classification while persisting the explicit outcome.
          throw sendError ?? new Error('outbound not_sent');
        }
      } catch (error) {
        const errorMsg = this.toErrorMessage(error);

        const classification = this.options?.classifyFailure?.({
          error,
          job: claimedJob,
        });
        const terminal = classification
          ? classification.terminal
          : (this.hooks?.isTerminalError?.(error) ??
            claimedJob.retryCount + 1 >= claimedJob.maxRetries);
        const persistedErrorMessage = errorMessage(
          classification?.errorMessage ?? errorMsg,
          { externalUserId: claimedJob.externalUserId },
        );

        const nextRetryCount = claimedJob.retryCount + 1;
        const backoffMs = settings.retryBackoffMinutes * 60 * 1000;
        const nominalBackoffMs =
          this.options?.backoffMode === 'flat'
            ? backoffMs
            : backoffMs * Math.pow(2, claimedJob.retryCount);
        const nextRetryAt = terminal
          ? undefined
          : new Date(
              now.getTime() +
                jitteredDelayMs(nominalBackoffMs, this.options?.rng),
            );

        await this.jobRepository.markFailed({
          jobId: claimedJob.id,
          leaseToken,
          errorMessage: persistedErrorMessage,
          // A terminal known failure must be fenced out of both direct
          // claims and the next periodic sync; retry exhaustion is the
          // existing durable terminal marker for `not_sent`.
          retryCount: terminal
            ? Math.max(nextRetryCount, claimedJob.maxRetries)
            : nextRetryCount,
          nextRetryAt,
          terminal,
          deliveryStatus: 'not_sent',
        });
        failures.push({
          jobId: claimedJob.id,
          externalUserId: claimedJob.externalUserId,
          error: persistedErrorMessage,
        });

        if (terminal) {
          failed += 1;
          this.hooks?.onFailed?.({
            jobId: claimedJob.id,
            externalUserId: claimedJob.externalUserId,
            error: persistedErrorMessage,
          });
          this.logger.warn(
            `Study reminder job failed terminal jobId=${claimedJob.id} externalUserId=${maskExternalId(
              claimedJob.externalUserId,
            )}: ${persistedErrorMessage}`,
          );
        } else {
          retried += 1;
          this.hooks?.onRetried?.({
            jobId: claimedJob.id,
            externalUserId: claimedJob.externalUserId,
            retryCount: nextRetryCount,
          });
          this.logger.warn(
            `Study reminder job retry jobId=${claimedJob.id} externalUserId=${maskExternalId(
              claimedJob.externalUserId,
            )} retry=${nextRetryCount}/${claimedJob.maxRetries}: ${persistedErrorMessage}`,
          );
        }
      }
    };

    // Process jobs with bounded producer concurrency (#1363).
    for (let i = 0; i < dueJobs.length; i += concurrencyLimit) {
      const batch = dueJobs.slice(i, i + concurrencyLimit);
      await Promise.allSettled(batch.map((job) => processJob(job)));
    }

    const nextDueAt = await this.jobRepository
      .findNextDueTime(now, this.platform)
      .catch((error) => {
        this.logger.warn(`findNextDueTime failed: ${errorMessage(error)}`);
        return null;
      });

    if (claimed > 0 || resetStuck > 0) {
      this.logger.log(
        `Study reminder dispatch: claimed=${claimed}, sent=${sent}, cancelled=${cancelled}, retried=${retried}, failed=${failed}, resetStuck=${resetStuck}`,
      );
    }

    return {
      claimed,
      sent,
      cancelled,
      retried,
      failed,
      resetStuck,
      nextDueAt,
      failures,
    };
  }

  private async buildReminderText(
    job: StudyReminderJob,
    timeLabel: string,
    minutesUntil: number,
  ): Promise<string> {
    if (this.hooks?.generateReminder) {
      return this.hooks.generateReminder(
        {
          calendarId: job.sessionKey,
          sessionKey: job.sessionKey,
          scheduledAt: job.scheduledAt,
          topic: job.topic,
        },
        {
          externalUserId: job.externalUserId,
          userId: job.userId,
          timeLabel,
          minutesUntil,
          jobId: job.id,
        },
      );
    }

    const topic = job.topic || 'học tập';
    return `Nhắc lịch: Bạn có lịch ${topic} lúc ${timeLabel} (còn ${minutesUntil} phút).`;
  }

  private toErrorMessage(error: unknown): string {
    return errorMessage(error);
  }
}
