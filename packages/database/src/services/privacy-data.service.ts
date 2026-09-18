import { Logger } from '@nestjs/common';
import type {
  DataSource,
  EntityTarget,
  EntityManager,
  ObjectLiteral,
  Repository,
} from 'typeorm';
import { IsNull } from 'typeorm';
import { createHash } from 'crypto';
import {
  acquireStudyReminderOwnershipLock,
  acquireStudyReminderOwnershipMutationLock,
} from '@wispace/bot-common/locks';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { jitteredDelayMs, sleep } from '@wispace/bot-common/utils';
import type { Platform } from '@wispace/contracts';
import {
  PRIVACY_CLEANUP_REQUEST_ATTEMPTS,
  PRIVACY_CLEANUP_STORES,
  PrivacyCleanupJobStore,
  type PrivacyCleanupJobRef,
  type PrivacyCleanupStore,
} from './privacy-cleanup-job.service';
import { PrivacyCleanupJobEntity } from '../entities/privacy-cleanup-job.entity';

/**
 * Per-call Redis/state cleanup callbacks, wired by each app's ops controller.
 * All callbacks are own-platform: a bot only clears Redis keys it owns —
 * cross-platform erasure is achieved by the backend calling each bot's
 * privacy/delete endpoint (#537).
 */
export interface PrivacyStateCleanup {
  /** The adapter's platform boundary; cross-platform ids are never accepted. */
  platform?: Platform;
  /** Explicitly configured stores. Omitted only for legacy direct callers. */
  applicableStores?: readonly PrivacyCleanupStore[];
  clearHistory?: (externalUserId: string) => Promise<void>;
  clearQueuedWork?: (externalUserId: string) => Promise<void>;
  clearClarification?: (externalUserId: string) => Promise<void>;
  /** Clears internal-userId-keyed caches (e.g. display-name cache). */
  clearUserCache?: (userId: number) => Promise<void>;
  /** Low-cardinality request/worker telemetry hook. */
  onAttempt?: (
    store: PrivacyCleanupStore,
    outcome: 'success' | 'failure' | 'stale' | 'skipped',
  ) => void;
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
 *   - discord_welcome_records, zalo_welcome_records
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
  /** Authoritative database mutation boolean for unlink callers. */
  unlinked?: boolean;
  /** The WISPACE userId that was unlinked (for logging/audit). */
  userId?: number;
  /** True when the mapping changed since it was captured — action refused. */
  conflict?: boolean;
  status?: 'complete' | 'incomplete';
  cleanupId?: string;
  outstandingStores?: PrivacyCleanupStore[];
}

export interface PrivacyDeleteResult {
  deleted: boolean;
  userId?: number;
  conflict?: boolean;
  status: 'complete' | 'incomplete';
  cleanupId?: string;
  outstandingStores: PrivacyCleanupStore[];
}

/** Identity snapshot captured before a chat privacy confirmation. */
export interface PrivacyExpectedMapping {
  exists: boolean;
  userId?: number;
  mappingGeneration?: string;
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
 * Check the ownership fence immediately before a state-store action. A job
 * may outlive the mapping row, so an active owner always wins over replay.
 */
export async function isPrivacyCleanupGenerationCurrent(
  dataSource: Pick<DataSource, 'query'>,
  platform: Platform,
  externalUserId: string,
  mappingGeneration: string,
): Promise<boolean> {
  if (typeof dataSource.query !== 'function') {
    throw new Error('privacy cleanup generation fence unavailable');
  }
  const mappingTableName = MAPPING_TABLES[platform];
  if (!mappingTableName) {
    throw new Error(`Unknown platform: ${platform}`);
  }
  const mappingRows = (await dataSource.query(
    `SELECT mapping_generation, link_state
       FROM "${mappingTableName}"
      WHERE platform = $1 AND external_user_id = $2`,
    [platform, externalUserId],
  )) as Array<{ mapping_generation?: string | number; link_state?: string }>;
  const mapping = mappingRows[0];
  if (mapping) {
    if (
      mapping.link_state !== 'locally-unlinked' &&
      mapping.link_state !== 'confirmed-revoked'
    ) {
      // Unknown/temporarily-unknown states fail closed: a live owner must
      // never lose state to an older cleanup job.
      return false;
    }
    return sameOrOlderGeneration(mappingGeneration, mapping.mapping_generation);
  }

  const auditRows = (await dataSource.query(
    `SELECT mapping_generation
       FROM platform_link_audit_events
      WHERE platform = $1
        AND external_user_hash = $2
        AND event_type = 'locally_unlinked'
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [platform, createHash('sha256').update(externalUserId).digest('hex')],
  )) as Array<{ mapping_generation?: string | number }>;
  const latest = auditRows[0]?.mapping_generation;
  return latest === undefined
    ? true
    : sameOrOlderGeneration(mappingGeneration, latest);
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
    private readonly cleanupJobs = new PrivacyCleanupJobStore(dataSource),
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
      ['privacyCleanupJobs', PrivacyCleanupJobEntity],
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
    expectedMapping?: PrivacyExpectedMapping,
  ): Promise<PrivacyUnlinkResult> {
    const currentPlatform = this.assertCurrentPlatform(platform);
    const durableCleanup = isDurableCleanup(cleanup);
    if (durableCleanup)
      this.assertCleanupConfiguration(currentPlatform, cleanup!);
    const repo = this.getMappingRepo(currentPlatform);
    const initialMapping = await repo.findOne({
      where: { platform: currentPlatform, externalUserId },
    });
    if (
      expectedMapping &&
      !mappingMatchesExpected(initialMapping, expectedMapping)
    ) {
      return durableCleanup
        ? { deleted: false, unlinked: false, conflict: true }
        : { deleted: false };
    }
    if (!durableCleanup && !expectedMapping && initialMapping) {
      const userId = readMappingUserId(initialMapping);
      const currentState = (initialMapping as { linkState?: string }).linkState;
      if (
        currentState === 'locally-unlinked' ||
        currentState === 'confirmed-revoked'
      ) {
        await this.runLegacyCleanup(externalUserId, cleanup, userId);
        return { deleted: false, userId };
      }
    }

    let mapping = initialMapping;
    let conflict = false;
    let deleted = false;
    let userId: number | undefined;
    let cleanupGeneration = '1';
    let cleanupRefs: PrivacyCleanupJobRef[] = [];

    await this.dataSource.transaction(async (manager) => {
      await acquireStudyReminderOwnershipMutationLock(manager);
      await acquireStudyReminderOwnershipLock(
        manager,
        currentPlatform,
        externalUserId,
      );
      // Re-read under the ownership lock. The initial read only supports the
      // cheap expected-mapping conflict/terminal fast paths above.
      mapping = await lockPrivacyMapping(
        manager,
        this.registry.mappings[currentPlatform],
        currentPlatform,
        externalUserId,
      );
      if (expectedMapping) {
        if (!mappingMatchesExpected(mapping, expectedMapping)) {
          conflict = true;
          return;
        }
      }

      if (!mapping) {
        const generation = await currentLocalUnlinkGeneration(
          manager,
          currentPlatform,
          externalUserId,
        );
        await writeLocalUnlinkAudit(
          manager,
          currentPlatform,
          externalUserId,
          generation,
        );
        cleanupGeneration = generation;
        await cancelLocalUnlinkWork(manager, currentPlatform, externalUserId);
        await manager.query(
          `DELETE FROM learner_profiles
           WHERE platform = $1 AND external_user_id = $2`,
          [currentPlatform, externalUserId],
        );
        await deleteVerifyIntent(manager, currentPlatform, externalUserId);
        if (durableCleanup) {
          cleanupRefs = await this.enqueueCleanupJobs(manager, {
            operation: 'unlink',
            platform: currentPlatform,
            externalUserId,
            mappingGeneration: cleanupGeneration,
            cleanup: cleanup!,
          });
        }
        return;
      }

      userId = readMappingUserId(mapping);
      const currentState = (mapping as unknown as { linkState?: string })
        .linkState;
      if (
        currentState === 'locally-unlinked' ||
        currentState === 'confirmed-revoked'
      ) {
        cleanupGeneration = String(
          (mapping as unknown as { mappingGeneration?: string })
            .mappingGeneration ?? '1',
        );
        if (durableCleanup) {
          cleanupRefs = await this.enqueueCleanupJobs(manager, {
            operation: 'unlink',
            platform: currentPlatform,
            externalUserId,
            userId,
            mappingGeneration: cleanupGeneration,
            cleanup: cleanup!,
          });
        }
        return;
      }
      const generation = String(
        BigInt(
          (mapping as unknown as { mappingGeneration?: string })
            .mappingGeneration ?? '1',
        ) + 1n,
      );
      cleanupGeneration = generation;
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
      if (durableCleanup) {
        cleanupRefs = await this.enqueueCleanupJobs(manager, {
          operation: 'unlink',
          platform: currentPlatform,
          externalUserId,
          userId,
          mappingGeneration: cleanupGeneration,
          cleanup: cleanup!,
        });
      }
      deleted = true;
    });

    if (conflict) {
      return durableCleanup
        ? { deleted: false, unlinked: false, conflict: true }
        : { deleted: false, conflict: true };
    }
    if (!durableCleanup) {
      await this.runLegacyCleanup(externalUserId, cleanup, userId);
      return { deleted, userId };
    }

    const outcome = await this.executeCleanup(
      cleanupRefs,
      cleanup!,
      externalUserId,
      userId,
      currentPlatform,
      cleanupGeneration,
    );
    return {
      deleted,
      unlinked: deleted,
      userId,
      ...outcome,
    };
  }

  /**
   * Delete: atomic cascade-remove all local data for a user.
   *
   * 1. Inside a single transaction:
   *    a. Look up + remove the platform mapping (returns userId for cross-platform delete)
   *    b. Delete all other platform mappings by userId
   *    c. Delete all userId-scoped local records
   * 2. Enqueue and execute own-platform state cleanup outside the transaction;
   *    durable callers receive an explicit completion outcome.
   *
   * Idempotent — safe to call multiple times. Returns without error if
   * the user was already deleted.
   */
  async delete(
    platform: string,
    externalUserId: string,
    cleanup?: PrivacyStateCleanup,
    expectedMapping?: PrivacyExpectedMapping,
  ): Promise<PrivacyDeleteResult | boolean | void> {
    const currentPlatform = this.assertCurrentPlatform(platform);
    const durableCleanup = isDurableCleanup(cleanup);
    if (durableCleanup)
      this.assertCleanupConfiguration(currentPlatform, cleanup!);
    // 1. Atomic transaction: mapping removal + all userId-scoped deletes
    let userId: number | undefined;
    let conflict = false;
    let deleted = false;
    let cleanupGeneration = '1';
    let cleanupRefs: PrivacyCleanupJobRef[] = [];
    const cleanupExternalIds = new Set<string>([externalUserId]);

    await this.dataSource.transaction(async (manager) => {
      await acquireStudyReminderOwnershipMutationLock(manager);
      await acquireStudyReminderOwnershipLock(
        manager,
        currentPlatform,
        externalUserId,
      );
      // 1a. Look up and remove the platform mapping INSIDE the transaction
      const mappingRepo = manager.getRepository(
        this.registry.mappings[currentPlatform],
      );
      const mapping = await lockPrivacyMapping(
        manager,
        this.registry.mappings[currentPlatform],
        currentPlatform,
        externalUserId,
      );
      if (
        expectedMapping &&
        !mappingMatchesExpected(mapping, expectedMapping)
      ) {
        conflict = true;
        return;
      }
      if (mapping) {
        userId = readMappingUserId(mapping);
        cleanupGeneration = String(
          (mapping as unknown as { mappingGeneration?: string })
            .mappingGeneration ?? '1',
        );
        await writeLocalUnlinkAudit(
          mockableQueryManager(manager),
          currentPlatform,
          externalUserId,
          (mapping as unknown as { mappingGeneration?: string })
            .mappingGeneration,
        );
        await cancelLocalUnlinkWork(manager, currentPlatform, externalUserId);
        await mappingRepo.remove(mapping);
        deleted = true;
      } else if (durableCleanup) {
        // Preserve the latest tombstone generation when the mapping is already
        // absent; otherwise a delete retry could be fenced stale forever.
        cleanupGeneration = await currentLocalUnlinkGeneration(
          manager,
          currentPlatform,
          externalUserId,
        );
      }

      // 1b. Delete mappings for OTHER platforms if userId is known
      if (userId) {
        const otherMappings: Array<{
          platform: Platform;
          externalUserId: string;
          mapping: ObjectLiteral;
        }> = [];
        for (const p of PLATFORMS) {
          if (p === currentPlatform) continue;
          const repo = manager.getRepository(this.registry.mappings[p]);
          const mappings = await repo.find({ where: { userId } });
          for (const otherMapping of mappings) {
            const externalId = (otherMapping as { externalUserId?: string })
              .externalUserId;
            if (externalId) {
              otherMappings.push({
                platform: p,
                externalUserId: externalId,
                mapping: otherMapping,
              });
            }
          }
        }
        for (const other of otherMappings.sort((a, b) =>
          `${a.platform}:${a.externalUserId}`.localeCompare(
            `${b.platform}:${b.externalUserId}`,
          ),
        )) {
          await acquireStudyReminderOwnershipLock(
            manager,
            other.platform,
            other.externalUserId,
          );
          cleanupExternalIds.add(other.externalUserId);
          await writeLocalUnlinkAudit(
            manager,
            other.platform,
            other.externalUserId,
            (other.mapping as { mappingGeneration?: string }).mappingGeneration,
          );
          await cancelLocalUnlinkWork(
            manager,
            other.platform,
            other.externalUserId,
          );
          await deleteVerifyIntent(
            manager,
            other.platform,
            other.externalUserId,
          );
        }
        for (const p of PLATFORMS) {
          if (p === currentPlatform) continue;
          const repo = manager.getRepository(this.registry.mappings[p]);
          await repo.delete({ userId });
        }
      }

      // 1c. Delete by (platform, externalUserId) — covers current platform
      // and any remaining records if userId was null
      const deleteByUser = async (
        target: PrivacyEntityTarget,
        overrideUserId?: number,
        options: { anonymousOnly?: boolean } = {},
      ) => {
        const repo = manager.getRepository(target);
        if (overrideUserId) {
          await repo.delete({ userId: overrideUserId });
        } else {
          await repo.delete({
            platform: currentPlatform,
            externalUserId,
            ...(options.anonymousOnly ? { userId: IsNull() } : {}),
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
      // Daily usage is owner-scoped (#1177): erasing a learner removes the rows
      // owned by that WISPACE userId, while an erasure without a userId removes
      // only the anonymous bucket for the channel — a learner row for the same
      // channel/date belongs to another learner and must survive.
      await deleteByUser(this.registry.scoped.chatDailyUsage, uid, {
        anonymousOnly: true,
      });
      await deleteByUser(this.registry.scoped.llmUsageEvent, uid);
      await deleteByUser(this.registry.scoped.chatIdempotency, uid);
      if (uid) {
        // Notification consent state (#596) is keyed by userId only.
        await manager
          .getRepository(this.registry.scoped.notificationPreference)
          .delete({ userId: uid });
      }
      await deleteVerifyIntent(manager, currentPlatform, externalUserId);
      if (durableCleanup) {
        cleanupRefs = await this.enqueueCleanupJobs(manager, {
          operation: 'delete',
          platform: currentPlatform,
          externalUserId,
          userId,
          mappingGeneration: cleanupGeneration,
          cleanup: cleanup!,
        });
      }
    });

    if (conflict) {
      return durableCleanup
        ? {
            deleted: false,
            conflict: true,
            status: 'complete',
            outstandingStores: [],
          }
        : false;
    }

    if (!durableCleanup) {
      // Legacy direct callers may still supply a callback without the explicit
      // adapter boundary. Keep their historical cross-platform fan-out until
      // all callers use the durable contract.
      await Promise.all(
        [...cleanupExternalIds].map((id) =>
          this.runLegacyCleanup(id, cleanup, userId),
        ),
      );
      return expectedMapping ? true : undefined;
    }

    const outcome = await this.executeCleanup(
      cleanupRefs,
      cleanup!,
      externalUserId,
      userId,
      currentPlatform,
      cleanupGeneration,
    );
    return {
      deleted,
      userId,
      ...outcome,
    };
  }

  /**
   * Export: collect all local data for a user on a platform.
   * Returns structured JSON for user data portability (GDPR Art. 20).
   */
  async export(
    platform: string,
    externalUserId: string,
  ): Promise<PrivacyExportData>;
  async export(
    platform: string,
    externalUserId: string,
    expectedMapping?: PrivacyExpectedMapping,
  ): Promise<PrivacyExportData | null>;
  async export(
    platform: string,
    externalUserId: string,
    expectedMapping?: PrivacyExpectedMapping,
  ): Promise<PrivacyExportData | null> {
    const currentPlatform = this.assertCurrentPlatform(platform);
    const readExport = async (
      manager?: EntityManager,
    ): Promise<PrivacyExportData | null> => {
      const mapping = expectedMapping
        ? await lockPrivacyMapping(
            manager!,
            this.registry.mappings[currentPlatform],
            currentPlatform,
            externalUserId,
          )
        : await (
            manager?.getRepository(this.registry.mappings[currentPlatform]) ??
            this.getMappingRepo(currentPlatform)
          ).findOne({
            where: { platform: currentPlatform, externalUserId },
          });
      if (
        expectedMapping &&
        !mappingMatchesExpected(mapping, expectedMapping)
      ) {
        return null;
      }

      const getRepository = (target: PrivacyEntityTarget) =>
        manager?.getRepository(target) ?? this.dataSource.getRepository(target);
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

      const profile = await getRepository(
        this.registry.scoped.learnerProfile,
      ).findOne({ where: { platform: currentPlatform, externalUserId } });
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

      result.studyReminderJobs = await getRepository(
        this.registry.scoped.studyReminderJob,
      ).count({ where: { platform: currentPlatform, externalUserId } });
      result.scheduledReportClaims = await getRepository(
        this.registry.scoped.scheduledReportClaim,
      ).count({ where: { platform: currentPlatform, externalUserId } });
      result.reportSendJobs = await getRepository(
        this.registry.scoped.reportSendJob,
      ).count({ where: { platform: currentPlatform, externalUserId } });
      result.messageLogs = await getRepository(this.registry.messageLog).count({
        where: { platform: currentPlatform, externalUserId },
      });

      return result;
    };

    return expectedMapping
      ? this.dataSource.transaction(readExport)
      : readExport();
  }

  private async runLegacyCleanup(
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

  private assertCleanupConfiguration(
    platform: Platform,
    cleanup: PrivacyStateCleanup,
  ): void {
    if (cleanup.platform && cleanup.platform !== platform) {
      throw new Error(
        `Privacy cleanup adapter is configured for ${cleanup.platform}, not ${platform}`,
      );
    }
    const stores =
      cleanup.applicableStores ??
      (cleanup.platform
        ? DEFAULT_CLEANUP_STORES_BY_PLATFORM[cleanup.platform]
        : inferCleanupStores(cleanup));
    for (const store of stores) {
      if (!hasPrivacyCleanupAdapter(cleanup, store)) {
        throw new Error(
          `Privacy cleanup adapter missing for configured store: ${store}`,
        );
      }
    }
  }

  private async enqueueCleanupJobs(
    manager: Pick<EntityManager, 'query'>,
    input: {
      operation: 'unlink' | 'delete';
      platform: Platform;
      externalUserId: string;
      userId?: number;
      mappingGeneration: string;
      cleanup: PrivacyStateCleanup;
    },
  ): Promise<PrivacyCleanupJobRef[]> {
    const stores = applicableCleanupStores(input.cleanup, input.userId);
    if (stores.length === 0) return [];
    return this.cleanupJobs.enqueue(manager, {
      operation: input.operation,
      platform: input.platform,
      externalUserId: input.externalUserId,
      ...(input.userId === undefined ? {} : { userId: input.userId }),
      mappingGeneration: input.mappingGeneration,
      stores,
    });
  }

  private async executeCleanup(
    refs: PrivacyCleanupJobRef[],
    cleanup: PrivacyStateCleanup,
    externalUserId: string,
    userId?: number,
    platform = this.registry.platform,
    mappingGeneration = '1',
  ): Promise<{
    status: 'complete' | 'incomplete';
    cleanupId?: string;
    outstandingStores: PrivacyCleanupStore[];
  }> {
    if (refs.length === 0) {
      return { status: 'complete', outstandingStores: [] };
    }

    const cleanupId = refs[0].cleanupId;
    let existing: Awaited<ReturnType<PrivacyCleanupJobStore['getByCleanupId']>>;
    try {
      existing = await this.cleanupJobs.getByCleanupId(
        cleanupId,
        cleanup.platform ?? this.registry.platform,
      );
    } catch (error) {
      this.logger.warn(
        `Privacy cleanup status unavailable: ${errorMessage(error, { externalUserId, maxChars: 160 })}`,
      );
      return {
        status: 'incomplete',
        cleanupId,
        outstandingStores: refs.map((ref) => ref.store),
      };
    }
    const statuses = new Map(existing.map((row) => [row.store, row]));

    await Promise.all(
      refs.map(async (ref) => {
        const row = statuses.get(ref.store);
        if (row?.status === 'completed' || row?.status === 'stale') {
          cleanup.onAttempt?.(ref.store, 'skipped');
          return;
        }
        const action = privacyCleanupCallbackForStore(
          cleanup,
          ref.store,
          externalUserId,
          userId,
        );
        if (!action) {
          throw new Error(
            `Privacy cleanup adapter missing for configured store: ${ref.store}`,
          );
        }
        let attemptCount = row?.attemptCount ?? ref.attemptCount ?? 0;
        for (
          let attempt = 0;
          attempt < PRIVACY_CLEANUP_REQUEST_ATTEMPTS;
          attempt += 1
        ) {
          try {
            // Re-check immediately before every adapter call. Relinking may
            // happen after a failed attempt while this request is still alive.
            if (
              !(await isPrivacyCleanupGenerationCurrent(
                this.dataSource,
                platform,
                externalUserId,
                mappingGeneration,
              ))
            ) {
              await this.cleanupJobs.markStale(ref);
              cleanup.onAttempt?.(ref.store, 'stale');
              return;
            }
            await action();
            await this.cleanupJobs.markCompleted(ref);
            cleanup.onAttempt?.(ref.store, 'success');
            return;
          } catch (error) {
            cleanup.onAttempt?.(ref.store, 'failure');
            try {
              await this.cleanupJobs.markFailure(
                { ...ref, attemptCount },
                errorMessage(error, {
                  externalUserId,
                  maxChars: 160,
                }),
              );
            } catch (persistError) {
              this.logger.warn(
                `Privacy cleanup retry state unavailable: ${errorMessage(persistError, { externalUserId, maxChars: 160 })}`,
              );
            }
            attemptCount += 1;
            if (attempt + 1 < PRIVACY_CLEANUP_REQUEST_ATTEMPTS) {
              await sleep(jitteredDelayMs(50 * 2 ** attempt));
            }
          }
        }
      }),
    );

    let after: Awaited<ReturnType<PrivacyCleanupJobStore['getByCleanupId']>>;
    try {
      after = await this.cleanupJobs.getByCleanupId(
        cleanupId,
        cleanup.platform ?? this.registry.platform,
      );
    } catch (error) {
      this.logger.warn(
        `Privacy cleanup status unavailable: ${errorMessage(error, { externalUserId, maxChars: 160 })}`,
      );
      return {
        status: 'incomplete',
        cleanupId,
        outstandingStores: refs.map((ref) => ref.store),
      };
    }
    const afterByKey = new Map(
      after.map((row) => [row.idempotencyKey, row] as const),
    );
    const outstandingStores = refs
      .filter((ref) => {
        const row = afterByKey.get(ref.idempotencyKey);
        return !row || (row.status !== 'completed' && row.status !== 'stale');
      })
      .map((ref) => ref.store);
    return outstandingStores.length > 0
      ? { status: 'incomplete', cleanupId, outstandingStores }
      : { status: 'complete', outstandingStores: [] };
  }
}

function readMappingUserId(
  mapping: ObjectLiteral | null | undefined,
): number | undefined {
  const userId = (mapping as { userId?: number | null } | null | undefined)
    ?.userId;
  return typeof userId === 'number' ? userId : undefined;
}

const DEFAULT_CLEANUP_STORES_BY_PLATFORM: Record<
  Platform,
  readonly PrivacyCleanupStore[]
> = {
  messenger: PRIVACY_CLEANUP_STORES,
  discord: PRIVACY_CLEANUP_STORES.filter(
    (store) => store !== 'display_name_cache',
  ),
  zalo: PRIVACY_CLEANUP_STORES.filter(
    (store) => store !== 'display_name_cache',
  ),
};

function isDurableCleanup(cleanup?: PrivacyStateCleanup): boolean {
  return Boolean(cleanup?.platform || cleanup?.applicableStores);
}

function inferCleanupStores(
  cleanup: PrivacyStateCleanup,
): readonly PrivacyCleanupStore[] {
  return PRIVACY_CLEANUP_STORES.filter((store) =>
    Boolean(privacyCleanupCallbackForStore(cleanup, store)),
  );
}

function applicableCleanupStores(
  cleanup: PrivacyStateCleanup,
  userId?: number,
): PrivacyCleanupStore[] {
  const configured =
    cleanup.applicableStores ??
    DEFAULT_CLEANUP_STORES_BY_PLATFORM[cleanup.platform ?? 'messenger'];
  return [...new Set(configured)].filter(
    (store) => store !== 'display_name_cache' || userId !== undefined,
  );
}

export function privacyCleanupCallbackForStore(
  cleanup: PrivacyStateCleanup,
  store: PrivacyCleanupStore,
  externalUserId = '',
  userId?: number,
): (() => Promise<void>) | undefined {
  switch (store) {
    case 'chat_history':
      return cleanup.clearHistory
        ? () => cleanup.clearHistory!(externalUserId)
        : undefined;
    case 'chat_queue':
      return cleanup.clearQueuedWork
        ? () => cleanup.clearQueuedWork!(externalUserId)
        : undefined;
    case 'clarification_state':
      return cleanup.clearClarification
        ? () => cleanup.clearClarification!(externalUserId)
        : undefined;
    case 'display_name_cache':
      return cleanup.clearUserCache && userId !== undefined
        ? () => cleanup.clearUserCache!(userId ?? 0)
        : undefined;
  }
}

export function hasPrivacyCleanupAdapter(
  cleanup: PrivacyStateCleanup,
  store: PrivacyCleanupStore,
): boolean {
  switch (store) {
    case 'chat_history':
      return typeof cleanup.clearHistory === 'function';
    case 'chat_queue':
      return typeof cleanup.clearQueuedWork === 'function';
    case 'clarification_state':
      return typeof cleanup.clearClarification === 'function';
    case 'display_name_cache':
      return typeof cleanup.clearUserCache === 'function';
  }
}

function mappingMatchesExpected(
  mapping: ObjectLiteral | null | undefined,
  expected: PrivacyExpectedMapping,
): boolean {
  if (Boolean(mapping) !== expected.exists) return false;
  if (!mapping) return true;

  return (
    readMappingUserId(mapping) === expected.userId &&
    String(
      (mapping as { mappingGeneration?: string | number | null })
        .mappingGeneration ?? '1',
    ) === String(expected.mappingGeneration ?? '1')
  );
}

async function lockPrivacyMapping(
  manager: EntityManager,
  target: PrivacyEntityTarget,
  platform: Platform,
  externalUserId: string,
): Promise<ObjectLiteral | null> {
  return manager.getRepository(target).findOne({
    where: { platform, externalUserId },
    lock: { mode: 'pessimistic_write' },
  });
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

async function currentLocalUnlinkGeneration(
  manager: unknown,
  platform: Platform,
  externalUserId: string,
): Promise<string> {
  const queryManager = manager as QueryManager | undefined;
  if (!queryManager?.query) return '1';
  const rows = (await queryManager.query(
    `SELECT mapping_generation
       FROM platform_link_audit_events
      WHERE platform = $1 AND external_user_hash = $2
        AND event_type = 'locally_unlinked'
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [platform, createHash('sha256').update(externalUserId).digest('hex')],
  )) as Array<{ mapping_generation?: string | null }>;
  const previous = rows[0]?.mapping_generation;
  if (!previous) return '1';
  try {
    return String(BigInt(previous));
  } catch {
    throw new Error('invalid mapping generation tombstone');
  }
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

function sameOrOlderGeneration(
  jobGeneration: string,
  currentGeneration: string | number | undefined,
): boolean {
  if (currentGeneration === undefined) return true;
  try {
    return BigInt(jobGeneration) >= BigInt(String(currentGeneration));
  } catch {
    return false;
  }
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
