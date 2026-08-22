import type { DataSource, Repository } from 'typeorm';

/**
 * Platform-agnostic privacy operations: unlink, delete, export.
 *
 * All operations are idempotent — calling unlink/delete twice returns
 * the same result without error. Delete cascades to related local data
 * but preserves the WISPACE canonical user record (owned upstream).
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
} as const;

export class PrivacyDataService {
  private readonly mappingRepos: Map<string, Repository<unknown>>;

  constructor(private readonly dataSource: DataSource) {
    this.mappingRepos = new Map();
  }

  private getMappingRepo(platform: string): Repository<unknown> {
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
   * Delete: cascade-remove all local data for a user on a platform.
   * Mapping row + learner_profile + study_reminder_jobs +
   * scheduled_report_claims + report_send_jobs.
   * Message_logs preserved (audit trail, auto-cleaned by retention cron).
   */
  async delete(platform: string, externalUserId: string): Promise<void> {
    // 1. Delete mapping
    await this.unlink(platform, externalUserId);

    // 2. Delete learner_profile
    const learnerRepo = this.dataSource.getRepository(
      ENTITY_NAMES.learnerProfile,
    );
    await learnerRepo.delete({ platform, externalUserId });

    // 3. Delete study_reminder_jobs
    const reminderRepo = this.dataSource.getRepository(
      ENTITY_NAMES.studyReminderJob,
    );
    await reminderRepo.delete({ platform, externalUserId });

    // 4. Delete scheduled_report_claims
    const claimRepo = this.dataSource.getRepository(
      ENTITY_NAMES.scheduledReportClaim,
    );
    await claimRepo.delete({ platform, externalUserId });

    // 5. Delete report_send_jobs
    const reportRepo = this.dataSource.getRepository(
      ENTITY_NAMES.reportSendJob,
    );
    await reportRepo.delete({ platform, externalUserId });
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
