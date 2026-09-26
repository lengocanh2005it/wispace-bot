import { hashExternalId } from '@wispace/bot-common/masking';
import { extractQueryRows } from '@wispace/bot-common/utils';
import { PLATFORM_STORAGE } from '@wispace/contracts';
import type { Platform } from '@wispace/contracts';
import type { EntityManager } from 'typeorm';

export {
  acquireStudyReminderOwnershipLock,
  acquireStudyReminderOwnershipMutationLock,
  studyReminderOwnershipLockKey,
} from '@wispace/bot-common/locks';

export type StudyReminderOwnershipCancellationReason =
  | 'mapping_ownership_changed'
  | 'link_revoked'
  | 'locally_unlinked'
  | 'mapping_generation_missing';

/**
 * Invalidates cancellable jobs after an ownership transition. A missing
 * generation means the old row cannot be trusted and is cancelled too.
 */
export async function cancelStudyReminderJobsForOwnershipChange(
  manager: Pick<EntityManager, 'query'>,
  platform: Platform,
  externalUserId: string,
  options: {
    generation?: string;
    reason?: StudyReminderOwnershipCancellationReason;
  } = {},
): Promise<number> {
  const params: unknown[] = [platform, externalUserId];
  const predicates = [
    `platform = $1`,
    `external_user_id = $2`,
    `status IN ('pending', 'processing', 'failed')`,
  ];
  if (options.generation !== undefined) {
    params.push(options.generation);
    predicates.push(
      `(mapping_generation IS NULL OR mapping_generation < $${params.length}::bigint)`,
    );
  }
  params.push(options.reason ?? 'mapping_ownership_changed');
  const rows = extractQueryRows<{ id: number }>(
    await manager.query(
      `UPDATE study_reminder_jobs
       SET status = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
           processing_started_at = NULL, delivery_record = NULL,
           delivery_key = NULL, delivery_status = NULL, next_retry_at = NULL,
           last_error = $${params.length}, updated_at = now()
       WHERE ${predicates.join(' AND ')}
       RETURNING id`,
      params,
    ),
  );
  return rows.length;
}

export function studyReminderMappingTable(platform: Platform): string {
  return PLATFORM_STORAGE[platform].mappingTable;
}

/** Prevents a privacy-unlink tombstone from being reused at generation 1. */
export async function nextMappingGenerationAfterTombstone(
  manager: Pick<EntityManager, 'query'>,
  platform: Platform,
  externalUserId: string,
): Promise<string> {
  const rows = extractQueryRows<{ mapping_generation: string | null }>(
    await manager.query(
      `SELECT mapping_generation
       FROM platform_link_audit_events
      WHERE platform = $1 AND external_user_hash = $2
         AND event_type = 'locally_unlinked'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [platform, hashExternalId(externalUserId)],
    ),
  );
  const previous = rows[0]?.mapping_generation;
  if (!previous) return '1';
  try {
    return String(BigInt(previous) + 1n);
  } catch {
    throw new Error('invalid mapping generation tombstone');
  }
}
