/**
 * #636 coherence contract — one TTL policy for every cached WISPACE read
 * (goals, calendar, score averages). WISPACE pushes no webhook for goal or
 * score changes, so these TTLs are the documented staleness bound; bot-side
 * mutations invalidate earlier (see WispaceDataCache.invalidateUser).
 *
 * Adding a new cached WISPACE read means adding a kind here — a read cannot
 * silently opt out of the staleness bound.
 */
export type WispaceCacheKind = 'goals' | 'calendar' | 'scores';

export const WISPACE_CACHE_POLICY: Record<WispaceCacheKind, number> = {
  /** Goals change rarely and drive reports — 60s matches the report memoizer. */
  goals: 60_000,
  /** Upcoming schedule misleads visibly when stale — short backstop only;
   *  reschedule invalidates immediately. */
  calendar: 15_000,
  /** Score averages only move when tasks are graded upstream. */
  scores: 300_000,
};
