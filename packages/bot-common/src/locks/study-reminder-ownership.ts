import type { Platform } from '@wispace/contracts';

type QueryManager = {
  query(sql: string, params?: readonly unknown[]): Promise<unknown>;
};

const STUDY_REMINDER_OWNERSHIP_MUTATION_LOCK =
  'study-reminder:ownership:mutation';

export function studyReminderOwnershipLockKey(
  platform: Platform,
  externalUserId: string,
): string {
  return `study-reminder:ownership:${platform}:${externalUserId}`;
}

/**
 * Serializes mapping mutations that can fan out to more than one external id.
 *
 * ponytail: one bounded lock keeps relink/privacy fan-out deadlock-free; move
 * to a sorted per-account lock set only if ownership-mutation throughput ever
 * becomes measurable.
 */
export async function acquireStudyReminderOwnershipMutationLock(
  manager: QueryManager,
): Promise<void> {
  await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    STUDY_REMINDER_OWNERSHIP_MUTATION_LOCK,
  ]);
}

/** All mapping writers and reminder delivery use this same transaction lock. */
export async function acquireStudyReminderOwnershipLock(
  manager: QueryManager,
  platform: Platform,
  externalUserId: string,
): Promise<void> {
  await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    studyReminderOwnershipLockKey(platform, externalUserId),
  ]);
}
