import { Logger } from '@nestjs/common';
import type {
  DataSource,
  EntityTarget,
  ObjectLiteral,
  Repository,
} from 'typeorm';
import { createHash } from 'crypto';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import type { Platform } from '@wispace/contracts';

/**
 * Per-call Redis/state cleanup callbacks, wired by each app's ops controller.
 * All callbacks are own-platform: a bot only clears Redis keys it owns —
 * cross-platform erasure is achieved by the backend calling each bot's
 * privacy/delete endpoint (#537).
 */
export interface PrivacyStateCleanup {
  clearHistory?: (externalUserId: string) => Promise<void>;
  clearQueuedWork?: (externalUserId: string) => Promise<void>;
  clearClarification?: (externalUserId: string) => Promise<void>;
  /** Clears internal-userId-keyed caches (e.g. display-name cache). */
  clearUserCache?: (userId: number) => Promise<void>;
}

/** Entity classes/schemas only; string targets would recreate implicit lookup. */
export type PrivacyEntityTarget = Exclude<EntityTarget<ObjectLiteral>, string>;

export interface PrivacyScopedEntities {
  learnerProfile: PrivacyEntityTarget;
  studyReminderJob: PrivacyEntityTarget;
  scheduledReportClaim: PrivacyEntityTarget;
  learnerScheduledReportClaim: PrivacyEntityTarget;
  reportSendJob: PrivacyEntityTarget;
  chatDailyUsage: PrivacyEntityTarget;
  llmUsageEvent: PrivacyEntityTarget;
  chatIdempotency: PrivacyEntityTarget;
  webActivity: PrivacyEntityTarget;
  notificationPreference: PrivacyEntityTarget;
}

/** Explicit TypeORM targets required by privacy operations in one app. */
export interface PrivacyEntityRegistry {
  platform: Platform;
  mappings: Record<Platform, PrivacyEntityTarget>;
  scoped: PrivacyScopedEntities;
  messageLog: PrivacyEntityTarget;
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
 *   - Redis chat history (via per-call PrivacyStateCleanup callbacks)
 *
 * Preserved (audit trail, auto-cleaned by retention cron):
 *   - message_logs
 *   - webhook_inbound_events, webhook_dead_letters
 *   - discord_welcome_records
 *
 * Not covered (no raw per-user identifier — aggregate_id is a SHA-256
 * pseudonym since #640, see docs/data-minimization-audit.md):
 *   - chat_quota_events (uses hashed aggregate_id)
 *
 * Redis scope (#537): cleanup callbacks clear ONLY this app's platform keys.
 * Cross-platform Redis erasure happens by calling each bot's privacy
 * endpoints — all paths are idempotent, so re-calls are safe.
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

const PLATFORMS = [
  'messenger',
  'discord',
  'zalo',
] as const satisfies readonly Platform[];

const MAPPING_TABLES: Record<Platform, string> = {
  messenger: 'user_platform_mappings',
  discord: 'discord_account_links',
  zalo: 'zalo_account_links',
};

const VERIFY_INTENT_TABLES: Record<Platform, string> = {
  messenger: 'messenger_link_verify_records',
  discord: 'discord_link_verify_records',
  zalo: 'zalo_link_verify_records',
};

const SCOPED_ENTITY_NAMES = [
  'learnerProfile',
  'studyReminderJob',
  'scheduledReportClaim',
  'learnerScheduledReportClaim',
  'reportSendJob',
  'chatDailyUsage',
  'llmUsageEvent',
  'chatIdempotency',
  'webActivity',
  'notificationPreference',
] as const satisfies readonly (keyof PrivacyScopedEntities)[];

export class PrivacyDataService {
  private readonly logger = new Logger(PrivacyDataService.name);
  private readonly mappingRepos = new Map<
    Platform,
    Repository<ObjectLiteral>
  >();

  constructor(
    private readonly dataSource: DataSource,
    private readonly registry: PrivacyEntityRegistry,
  ) {
    if (!registry) {
      throw new Error(
        'PrivacyDataService requires an explicit entity registry',
      );
    }
    this.assertEntityMetadata();
  }

  private getMappingRepo(platform: string): Repository<ObjectLiteral> {
    const target = this.registry.mappings[platform as Platform];
    if (!target) throw new Error(`Unknown platform: ${platform}`);
    const typedPlatform = platform as Platform;
    const cached = this.mappingRepos.get(typedPlatform);
    if (cached) return cached;
    const repo = this.dataSource.getRepository(target);
    this.mappingRepos.set(typedPlatform, repo);
    return repo;
  }

  private assertCurrentPlatform(platform: string): Platform {
    if (!(PLATFORMS as readonly string[]).includes(platform)) {
      throw new Error(`Unknown platform: ${platform}`);
    }
    if (platform !== this.registry.platform) {
      throw new Error(
        `PrivacyDataService is configured for ${this.registry.platform}, not ${platform}`,
      );
    }
    return platform as Platform;
  }

  private assertEntityMetadata(): void {
    const required: Array<[string, PrivacyEntityTarget | undefined]> = [
      ...PLATFORMS.map(
        (platform) =>
          [`mappings.${platform}`, this.registry.mappings?.[platform]] as [
            string,
            PrivacyEntityTarget | undefined,
          ],
      ),
      ...SCOPED_ENTITY_NAMES.map(
        (name) =>
          [`scoped.${name}`, this.registry.scoped?.[name]] as [
            string,
            PrivacyEntityTarget | undefined,
          ],
      ),
      ['messageLog', this.registry.messageLog],
    ];
    const missing = required
      .filter(
        ([, target]) =>
          !target ||
          typeof target === 'string' ||
          !this.dataSource.hasMetadata(target),
      )
      .map(([name, target]) => `${name} (${targetName(target)})`);
    if (missing.length > 0) {
      throw new Error(
        `PrivacyDataService missing TypeORM entity metadata: ${missing.join(', ')}`,
      );
    }
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
    const currentPlatform = this.assertCurrentPlatform(platform);
    const repo = this.getMappingRepo(currentPlatform);
    const mapping = await repo.findOne({
      where: { platform: currentPlatform, externalUserId },
    });

    if (!mapping) {
      await this.dataSource.transaction(async (manager) => {
        await writeLocalUnlinkAudit(
          manager,
          currentPlatform,
          externalUserId,
          '1',
        );
        await cancelLocalUnlinkWork(manager, currentPlatform, externalUserId);
        await manager.query(
          `DELETE FROM learner_profiles
           WHERE platform = $1 AND external_user_id = $2`,
          [currentPlatform, externalUserId],
        );
        await deleteVerifyIntent(manager, currentPlatform, externalUserId);
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
      await this.runCleanup(externalUserId, cleanup, userId);
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
        currentPlatform,
        externalUserId,
        generation,
      );
      await cancelLocalUnlinkWork(manager, currentPlatform, externalUserId);
      const table = mappingTable(currentPlatform);
      const statusSql =
        currentPlatform === 'messenger' ? `, status = 'INACTIVE'` : '';
      await manager.query(
        `UPDATE "${table}"
         SET link_state = 'locally-unlinked', mapping_generation = $3,
             revoked_at = now(), revocation_reason = 'privacy_unlink',
             updated_at = now()${statusSql}
         WHERE platform = $1 AND external_user_id = $2
           AND mapping_generation < $3::bigint`,
        [currentPlatform, externalUserId, generation],
      );
      await manager.query(
        `DELETE FROM learner_profiles
         WHERE platform = $1 AND external_user_id = $2`,
        [currentPlatform, externalUserId],
      );
      await deleteVerifyIntent(manager, currentPlatform, externalUserId);
    });
    await this.runCleanup(externalUserId, cleanup, userId);

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
    const currentPlatform = this.assertCurrentPlatform(platform);
    // 1. Atomic transaction: mapping removal + all userId-scoped deletes
    let userId: number | undefined;
    const cleanupExternalIds = new Set<string>([externalUserId]);

    await this.dataSource.transaction(async (manager) => {
      // 1a. Look up and remove the platform mapping INSIDE the transaction
      const mappingRepo = manager.getRepository(
        this.registry.mappings[currentPlatform],
      );
      const mapping = await mappingRepo.findOne({
        where: { platform: currentPlatform, externalUserId },
      });
      if (mapping) {
        userId = (mapping as unknown as { userId?: number }).userId;
        await writeLocalUnlinkAudit(
          mockableQueryManager(manager),
          currentPlatform,
          externalUserId,
          (mapping as unknown as { mappingGeneration?: string })
            .mappingGeneration,
        );
        await cancelLocalUnlinkWork(manager, currentPlatform, externalUserId);
        await mappingRepo.remove(mapping);
      }

      // 1b. Delete mappings for OTHER platforms if userId is known
      if (userId) {
        for (const p of PLATFORMS) {
          if (p === currentPlatform) continue;
          const repo = manager.getRepository(this.registry.mappings[p]);
          const mappings = await repo.find({ where: { userId } });
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
          await repo.delete({ userId });
        }
      }

      // 1c. Delete by (platform, externalUserId) — covers current platform
      // and any remaining records if userId was null
      const deleteByUser = async (
        target: PrivacyEntityTarget,
        overrideUserId?: number,
      ) => {
        const repo = manager.getRepository(target);
        if (overrideUserId) {
          await repo.delete({ userId: overrideUserId });
        } else {
          await repo.delete({
            platform: currentPlatform,
            externalUserId,
          });
        }
      };

      const uid = userId ?? undefined;

      await deleteByUser(this.registry.scoped.learnerProfile, uid);
      await deleteByUser(this.registry.scoped.studyReminderJob, uid);
      await deleteByUser(this.registry.scoped.scheduledReportClaim, uid);
      await deleteByUser(this.registry.scoped.learnerScheduledReportClaim, uid);
      await deleteByUser(this.registry.scoped.reportSendJob, uid);
      if (uid) {
        // web_activity is keyed by userId only — no (platform, externalUserId) fallback.
        // A mapping with no userId leaves a harmless orphan row (no cleanup cron).
        await manager
          .getRepository(this.registry.scoped.webActivity)
          .delete({ userId: uid });
      }

      // Group A: user data directly (new tables)
      await deleteByUser(this.registry.scoped.chatDailyUsage, uid);
      await deleteByUser(this.registry.scoped.llmUsageEvent, uid);
      await deleteByUser(this.registry.scoped.chatIdempotency, uid);
      if (uid) {
        // Notification consent state (#596) is keyed by userId only.
        await manager
          .getRepository(this.registry.scoped.notificationPreference)
          .delete({ userId: uid });
      }
      await deleteVerifyIntent(manager, currentPlatform, externalUserId);
    });

    // 2. Redis cleanup — outside transaction, best-effort, idempotent.
    //    Each bot clears its own platform's keys via per-call callbacks.
    //    Cross-platform Redis erasure requires calling each bot's endpoint.
    await Promise.all(
      [...cleanupExternalIds].map((id) => this.runCleanup(id, cleanup, userId)),
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
    const currentPlatform = this.assertCurrentPlatform(platform);
    // 1. Mapping info
    const repo = this.getMappingRepo(currentPlatform);
    const mapping = await repo.findOne({
      where: { platform: currentPlatform, externalUserId },
    });

    const result: PrivacyExportData = {
      platform: currentPlatform,
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
      this.registry.scoped.learnerProfile,
    );
    const profile = await learnerRepo.findOne({
      where: { platform: currentPlatform, externalUserId },
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
      this.registry.scoped.studyReminderJob,
    );
    result.studyReminderJobs = await reminderRepo.count({
      where: { platform: currentPlatform, externalUserId },
    });

    const claimRepo = this.dataSource.getRepository(
      this.registry.scoped.scheduledReportClaim,
    );
    result.scheduledReportClaims = await claimRepo.count({
      where: { platform: currentPlatform, externalUserId },
    });

    const reportRepo = this.dataSource.getRepository(
      this.registry.scoped.reportSendJob,
    );
    result.reportSendJobs = await reportRepo.count({
      where: { platform: currentPlatform, externalUserId },
    });

    const logRepo = this.dataSource.getRepository(this.registry.messageLog);
    result.messageLogs = await logRepo.count({
      where: { platform: currentPlatform, externalUserId },
    });

    return result;
  }

  private async runCleanup(
    externalUserId: string,
    cleanup?: PrivacyStateCleanup,
    userId?: number,
  ): Promise<void> {
    const actions = [
      cleanup?.clearHistory
        ? () => cleanup.clearHistory!(externalUserId)
        : undefined,
      cleanup?.clearQueuedWork
        ? () => cleanup.clearQueuedWork!(externalUserId)
        : undefined,
      cleanup?.clearClarification
        ? () => cleanup.clearClarification!(externalUserId)
        : undefined,
      cleanup?.clearUserCache && userId
        ? () => cleanup.clearUserCache!(userId)
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

function mappingTable(platform: Platform): string {
  const table = MAPPING_TABLES[platform];
  if (!table) throw new Error(`Unknown platform: ${platform}`);
  return table;
}

function targetName(target: PrivacyEntityTarget | undefined): string {
  if (!target) return 'missing';
  if (typeof target === 'string') return target;
  const candidate = target as {
    name?: string;
    options?: { name?: string };
  };
  return candidate.name ?? candidate.options?.name ?? String(target);
}

async function deleteVerifyIntent(
  manager: unknown,
  platform: Platform,
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
