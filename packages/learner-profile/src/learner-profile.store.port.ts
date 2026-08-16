import type { LearnerFacts, LearnerProfile } from './types';

/** DI token for `LearnerProfileStorePort` (runtime value — interfaces are not). */
export const LEARNER_PROFILE_STORE = 'LEARNER_PROFILE_STORE';

export interface LearnerProfileStorePort {
  /**
   * Loads the persisted profile for a platform identity, or null when the
   * learner has no profile yet.
   */
  get(platform: string, externalUserId: string): Promise<LearnerProfile | null>;

  /**
   * Merges facts into the learner's profile. Partial-update semantics:
   * fields absent from `facts` keep their previous values. A failed write
   * never affects the chat flow (callers treat it as best-effort).
   */
  upsert(
    platform: string,
    externalUserId: string,
    userId: number | undefined,
    facts: LearnerFacts,
  ): Promise<void>;
}
