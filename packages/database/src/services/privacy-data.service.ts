import type { DataSource, ObjectLiteral, Repository } from 'typeorm';

/**
 * Minimal interface for Redis chat history cleanup during erasure.
 * Avoids importing the full chat-history package into database.
 */
export interface ChatHistoryClearer {
  clear(externalUserId: string): Promise<void>;
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
 *   - Redis chat history (if ChatHistoryClearer provided)
 *
 * Preserved (audit trail, auto-cleaned by retention cron):
 *   - message_logs
 *   - webhook_inbound_events, webhook_dead_letters
 *   - discord/zalo_link_verify_records, discord_welcome_records
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
} as const;

export class PrivacyDataService {
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
   * Unlink: remove the platform mapping for a user.
   * Idempotent — returns deleted:false if already unlinked.
   */
  async unlink(
    platform: string,
    externalUserId: string,
  ): Promise<PrivacyUnlinkResult> {
    const repo = this.getMappingRepo(platform);
    const mapping = await repo.findOne({
      where: { platform, externalUserId } as never,
    });

    if (!mapping) {
      return { deleted: false };
    }

    const userId = (mapping as unknown as { userId?: number }).userId;
    await repo.remove(mapping);

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
  async delete(platform: string, externalUserId: string): Promise<void> {
    // 1. Atomic transaction: mapping removal + all userId-scoped deletes
    let userId: number | undefined;

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

      // Group A: user data directly (new tables)
      await deleteByUser(ENTITY_NAMES.chatDailyUsage, uid);
      await deleteByUser(ENTITY_NAMES.llmUsageEvent, uid);
      await deleteByUser(ENTITY_NAMES.chatIdempotency, uid);
    });

    // 2. Redis cleanup — outside transaction, best-effort, idempotent
    if (this.chatHistoryClearer) {
      await this.chatHistoryClearer.clear(externalUserId);
    }
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
}
