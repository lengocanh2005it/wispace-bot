import { Logger } from '@nestjs/common';
import type { DataSource, ObjectLiteral, Repository } from 'typeorm';
import { createHash } from 'crypto';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';

/**
 * Minimal interface for Redis chat history cleanup during erasure.
 * Avoids importing the full chat-history package into database.
 */
export interface ChatHistoryClearer {
  clear(externalUserId: string): Promise<void>;
}

export interface PrivacyStateCleanup {
  clearHistory?: (externalUserId: string) => Promise<void>;
  clearQueuedWork?: (externalUserId: string) => Promise<void>;
  clearClarification?: (externalUserId: string) => Promise<void>;
}

/**
 * Platform-agnostic privacy operations: unlink, delete, export.
 *
 * All operations are idempotent — calling unlink/delete twice returns
 * the same result without error. Delete cascades to related local data
 * but preserves the WISPACE canonical user record (owned upstream).
 *
 * Delete scope (atomic via transaction):
 *   - Platform mapping (messenger/discord/zalo)
 *   - Learner profile
 *   - Study reminder jobs
 *   - Scheduled report claims
 *   - Report send jobs
 *   - Chat daily usage (group A — user data directly)
 *   - LLM usage events (group A)
 *   - Chat idempotency records (group A)
 *   - Notification consent (user_notification_preferences, #596)
 *   - Web activity (userId-scoped; orphan row kept when mapping has no userId)
 *   - Redis chat history (if ChatHistoryClearer provided)
 *
 * Preserved (audit trail, auto-cleaned by retention cron):
 *   - message_logs
 *   - webhook_inbound_events, webhook_dead_letters
 *   - discord_welcome_records
 *
 * Not covered (no per-user identifier):
 *   - chat_quota_events (uses aggregate_id, documented only)
 */

export interface PrivacyUnlinkResult {
  /** Whether a mapping was actually deleted (false = already unlinked). */
  deleted: boolean;
  /** The WISPACE userId that was unlinked (for logging/audit). */
  userId?: number;
}

export interface PrivacyExportData {
  platform: string;
  externalUserId: string;
  linkedAt?: Date;
  learnerProfile?: {
    targetScore?: string;
    examDate?: string;
    fetchedAt?: Date;
  } | null;
  studyReminderJobs: number;
  scheduledReportClaims: number;
  reportSendJobs: number;
  messageLogs: number;
}

/**
 * Entity name constants for TypeORM repository lookup.
 * These match the @Entity() decorator names in each entity file.
 */
const ENTITY_NAMES = {
  messenger: 'UserPlatformMapping',
  discord: 'DiscordAccountLink',
  zalo: 'ZaloAccountLink',
  learnerProfile: 'LearnerProfile',
  studyReminderJob: 'StudyReminderJob',
  scheduledReportClaim: 'ScheduledReportClaim',
  reportSendJob: 'ReportSendJob',
  messageLog: 'MessageLog',
  chatDailyUsage: 'ChatDailyUsage',
  llmUsageEvent: 'LlmUsageEvent',
  chatIdempotency: 'ChatIdempotency',
  webActivity: 'WebActivity',
  notificationPreference: 'UserNotificationPreference',
} as const;

const MAPPING_TABLES: Record<string, string> = {
  messenger: 'user_platform_mappings',
  discord: 'discord_account_links',
  zalo: 'zalo_account_links',
};

const VERIFY_INTENT_TABLES: Record<string, string> = {
  messenger: 'messenger_link_verify_records',
  discord: 'discord_link_verify_records',
  zalo: 'zalo_link_verify_records',
};

export class PrivacyDataService {
  private readonly logger = new Logger(PrivacyDataService.name);
  private readonly mappingRepos: Map<string, Repository<ObjectLiteral>>;

  constructor(
    private readonly dataSource: DataSource,
    private readonly chatHistoryClearer?: ChatHistoryClearer,
  ) {
    this.mappingRepos = new Map();
  }

  private getMappingRepo(platform: string): Repository<ObjectLiteral> {
    if (this.mappingRepos.has(platform)) {
      return this.mappingRepos.get(platform)!;
    }
    const entityName = ENTITY_NAMES[platform as keyof typeof ENTITY_NAMES];
    if (!entityName) {
      throw new Error(`Unknown platform: ${platform}`);
    }
    const repo = this.dataSource.getRepository(entityName);
    this.mappingRepos.set(platform, repo);
    return repo;
  }

  /**
   * Unlink: invalidate the platform mapping while retaining its ownership
   * generation as a tombstone, so stale callbacks cannot resurrect it.
   * Idempotent — returns deleted:false if no mapping exists.
   */
  async unlink(
    platform: string,
    externalUserId: string,
    cleanup?: PrivacyStateCleanup,
  ): Promise<PrivacyUnlinkResult> {
    const repo = this.getMappingRepo(platform);
    const mapping = await repo.findOne({
      where: { platform, externalUserId } as never,
    });

    if (!mapping) {
      await this.dataSource.transaction(async (manager) => {
        await writeLocalUnlinkAudit(manager, platform, externalUserId, '1');
        await cancelLocalUnlinkWork(manager, platform, externalUserId);
        await manager.query(
          `DELETE FROM learner_profiles
           WHERE platform = $1 AND external_user_id = $2`,
          [platform, externalUserId],
        );
        await deleteVerifyIntent(manager, platform, externalUserId);
      });
      await this.runCleanup(externalUserId, cleanup);
      return { deleted: false };
    }

    const userId = (mapping as unknown as { userId?: number }).userId;
    const currentState = (mapping as unknown as { linkState?: string })
      .linkState;
    if (
      currentState === 'locally-unlinked' ||
      currentState === 'confirmed-revoked'
    ) {
      await this.runCleanup(externalUserId, cleanup);
      return { deleted: false, userId };
    }
    const generation = String(
      BigInt(
        (mapping as unknown as { mappingGeneration?: string })
          .mappingGeneration ?? '1',
      ) + 1n,
    );
    await this.dataSource.transaction(async (manager) => {
      await writeLocalUnlinkAudit(
        manager,
        platform,
        externalUserId,
        generation,
      );
      await cancelLocalUnlinkWork(manager, platform, externalUserId);
      const table = mappingTable(platform);
      const statusSql = platform === 'messenger' ? `, status = 'INACTIVE'` : '';
      await manager.query(
        `UPDATE "${table}"
         SET link_state = 'locally-unlinked', mapping_generation = $3,
             revoked_at = now(), revocation_reason = 'privacy_unlink',
             updated_at = now()${statusSql}
         WHERE platform = $1 AND external_user_id = $2
           AND mapping_generation < $3::bigint`,
        [platform, externalUserId, generation],
      );
      await manager.query(
        `DELETE FROM learner_profiles
         WHERE platform = $1 AND external_user_id = $2`,
        [platform, externalUserId],
      );
      await deleteVerifyIntent(manager, platform, externalUserId);
    });
    await this.runCleanup(externalUserId, cleanup);

    return { deleted: true, userId };
  }

  /**
   * Delete: atomic cascade-remove all local data for a user.
   *
   * 1. Inside a single transaction:
   *    a. Look up + remove the platform mapping (returns userId for cross-platform delete)
   *    b. Delete all other platform mappings by userId
   *    c. Delete all userId-scoped local records
   * 2. Clear Redis chat history (outside transaction — best-effort, idempotent)
   *
   * Idempotent — safe to call multiple times. Returns without error if
   * the user was already deleted.
   */
  async delete(
    platform: string,
    externalUserId: string,
    cleanup?: PrivacyStateCleanup,
  ): Promise<void> {
    // 1. Atomic transaction: mapping removal + all userId-scoped deletes
    let userId: number | undefined;
    const cleanupExternalIds = new Set([externalUserId]);

    await this.dataSource.transaction(async (manager) => {
      // 1a. Look up and remove the platform mapping INSIDE the transaction
      const mappingRepo = manager.getRepository(
        ENTITY_NAMES[platform as keyof typeof ENTITY_NAMES],
      );
      const mapping = await mappingRepo.findOne({
        where: { platform, externalUserId } as never,
      });
      if (mapping) {
        userId = (mapping as unknown as { userId?: number }).userId;
        await writeLocalUnlinkAudit(
          mockableQueryManager(manager),
          platform,
          externalUserId,
          (mapping as unknown as { mappingGeneration?: string })
            .mappingGeneration,
        );
        await cancelLocalUnlinkWork(manager, platform, externalUserId);
        await mappingRepo.remove(mapping);
      }

      // 1b. Delete mappings for OTHER platforms if userId is known
      if (userId) {
        for (const [p, entityName] of Object.entries({
          messenger: ENTITY_NAMES.messenger,
          discord: ENTITY_NAMES.discord,
          zalo: ENTITY_NAMES.zalo,
        })) {
          if (p === platform) continue;
          const repo = manager.getRepository(entityName);
          const find = (
            repo as unknown as {
              find?: (options: unknown) => Promise<ObjectLiteral[]>;
            }
          ).find;
          if (find) {
            const mappings = await find.call(repo, { where: { userId } });
            for (const otherMapping of mappings) {
              const externalId = (otherMapping as { externalUserId?: string })
                .externalUserId;
              if (externalId) {
                cleanupExternalIds.add(externalId);
                await writeLocalUnlinkAudit(
                  manager,
                  p,
                  externalId,
                  (otherMapping as { mappingGeneration?: string })
                    .mappingGeneration,
                );
                await cancelLocalUnlinkWork(manager, p, externalId);
                await deleteVerifyIntent(manager, p, externalId);
              }
            }
          }
          await repo.delete({ userId });
        }
      }

      // 1c. Delete by (platform, externalUserId) — covers current platform
      // and any remaining records if userId was null
      const deleteByUser = async (
        entityName: string,
        overrideUserId?: number,
      ) => {
        const repo = manager.getRepository(entityName);
        if (overrideUserId) {
          await repo.delete({ userId: overrideUserId } as never);
        } else {
          await repo.delete({ platform, externalUserId } as never);
        }
      };

      const uid = userId ?? undefined;

      await deleteByUser(ENTITY_NAMES.learnerProfile, uid);
      await deleteByUser(ENTITY_NAMES.studyReminderJob, uid);
      await deleteByUser(ENTITY_NAMES.scheduledReportClaim, uid);
      await deleteByUser(ENTITY_NAMES.reportSendJob, uid);
      if (uid) {
        // web_activity is keyed by userId only — no (platform, externalUserId) fallback.
        // A mapping with no userId leaves a harmless orphan row (no cleanup cron).
        await manager
          .getRepository(ENTITY_NAMES.webActivity)
          .delete({ userId: uid });
      }

      // Group A: user data directly (new tables)
      await deleteByUser(ENTITY_NAMES.chatDailyUsage, uid);
      await deleteByUser(ENTITY_NAMES.llmUsageEvent, uid);
      await deleteByUser(ENTITY_NAMES.chatIdempotency, uid);
      if (uid) {
        // Notification consent state (#596) is keyed by userId only.
        await manager
          .getRepository(ENTITY_NAMES.notificationPreference)
          .delete({ userId: uid });
      }
      await deleteVerifyIntent(manager, platform, externalUserId);
    });

    // 2. Redis cleanup — outside transaction, best-effort, idempotent
    await Promise.all(
      [...cleanupExternalIds].map((id) => this.runCleanup(id, cleanup)),
    );
  }

  /**
   * Export: collect all local data for a user on a platform.
   * Returns structured JSON for user data portability (GDPR Art. 20).
   */
  async export(
    platform: string,
    externalUserId: string,
  ): Promise<PrivacyExportData> {
    // 1. Mapping info
    const repo = this.getMappingRepo(platform);
    const mapping = await repo.findOne({
      where: { platform, externalUserId } as never,
    });

    const result: PrivacyExportData = {
      platform,
      externalUserId,
      linkedAt: mapping
        ? (mapping as unknown as { createdAt?: Date }).createdAt
        : undefined,
      studyReminderJobs: 0,
      scheduledReportClaims: 0,
      reportSendJobs: 0,
      messageLogs: 0,
    };

    // 2. Learner profile
    const learnerRepo = this.dataSource.getRepository(
      ENTITY_NAMES.learnerProfile,
    );
    const profile = await learnerRepo.findOne({
      where: { platform, externalUserId } as never,
    });
    if (profile) {
      const p = profile as unknown as {
        targetScore?: string;
        examDate?: string;
        fetchedAt?: Date;
      };
      result.learnerProfile = {
        targetScore: p.targetScore,
        examDate: p.examDate,
        fetchedAt: p.fetchedAt,
      };
    }

    // 3. Count related data
    const reminderRepo = this.dataSource.getRepository(
      ENTITY_NAMES.studyReminderJob,
    );
    result.studyReminderJobs = await reminderRepo.count({
      where: { platform, externalUserId } as never,
    });

    const claimRepo = this.dataSource.getRepository(
      ENTITY_NAMES.scheduledReportClaim,
    );
    result.scheduledReportClaims = await claimRepo.count({
      where: { platform, externalUserId } as never,
    });

    const reportRepo = this.dataSource.getRepository(
      ENTITY_NAMES.reportSendJob,
    );
    result.reportSendJobs = await reportRepo.count({
      where: { platform, externalUserId } as never,
    });

    const logRepo = this.dataSource.getRepository(ENTITY_NAMES.messageLog);
    result.messageLogs = await logRepo.count({
      where: { platform, externalUserId } as never,
    });

    return result;
  }

  private async runCleanup(
    externalUserId: string,
    cleanup?: PrivacyStateCleanup,
  ): Promise<void> {
    const clearHistory =
      cleanup?.clearHistory ?? this.chatHistoryClearer?.clear;
    const actions = [
      clearHistory ? () => clearHistory(externalUserId) : undefined,
      cleanup?.clearQueuedWork
        ? () => cleanup.clearQueuedWork!(externalUserId)
        : undefined,
      cleanup?.clearClarification
        ? () => cleanup.clearClarification!(externalUserId)
        : undefined,
    ].filter((action): action is () => Promise<void> => action !== undefined);
    await Promise.all(
      actions.map(async (action) => {
        try {
          await action();
        } catch (error) {
          this.logger.warn(
            `Privacy cache cleanup failed externalUserId=${maskExternalId(
              externalUserId,
            )}: ${errorMessage(error, { externalUserId, maxChars: 160 })}`,
          );
        }
      }),
    );
  }
}

async function writeLocalUnlinkAudit(
  manager: unknown,
  platform: string,
  externalUserId: string,
  mappingGeneration?: string,
): Promise<void> {
  const queryManager = manager as QueryManager | undefined;
  if (!queryManager?.query) return;
  await queryManager.query(
    `INSERT INTO platform_link_audit_events
      (platform, external_user_hash, mapping_generation, event_type, reason)
     VALUES ($1, $2, $3, 'locally_unlinked', 'privacy_unlink')`,
    [
      platform,
      createHash('sha256').update(externalUserId).digest('hex'),
      mappingGeneration ?? '1',
    ],
  );
}

async function cancelLocalUnlinkWork(
  manager: unknown,
  platform: string,
  externalUserId: string,
): Promise<void> {
  const queryManager = manager as QueryManager | undefined;
  if (!queryManager?.query) return;
  await queryManager.query(
    `UPDATE study_reminder_jobs
     SET status = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
         last_error = 'link_locally_unlinked', updated_at = now()
     WHERE platform = $1 AND external_user_id = $2
       AND status IN ('pending','processing','failed')`,
    [platform, externalUserId],
  );
  await queryManager.query(
    `UPDATE report_send_jobs
     SET status = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
         last_error = 'link_locally_unlinked', updated_at = now()
     WHERE platform = $1 AND external_user_id = $2
       AND status IN ('pending','processing','failed')`,
    [platform, externalUserId],
  );
  await queryManager.query(
    `UPDATE scheduled_report_claims
     SET status = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
         updated_at = now()
     WHERE platform = $1 AND external_user_id = $2 AND status = 'claimed'`,
    [platform, externalUserId],
  );
}

function mockableQueryManager(manager: unknown): QueryManager | undefined {
  return manager as QueryManager | undefined;
}

interface QueryManager {
  query(sql: string, params?: readonly unknown[]): Promise<unknown>;
}

function mappingTable(platform: string): string {
  const table = MAPPING_TABLES[platform];
  if (!table) throw new Error(`Unknown platform: ${platform}`);
  return table;
}

async function deleteVerifyIntent(
  manager: unknown,
  platform: string,
  externalUserId: string,
): Promise<void> {
  const table = VERIFY_INTENT_TABLES[platform];
  const queryManager = manager as QueryManager | undefined;
  if (!table || !queryManager?.query) return;
  const column = platform === 'messenger' ? 'psid' : `${platform}_user_id`;
  await queryManager.query(`DELETE FROM "${table}" WHERE "${column}" = $1`, [
    externalUserId,
  ]);
}
