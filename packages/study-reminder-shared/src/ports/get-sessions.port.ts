/**
 * Injection token for the authoritative session source (`GetSessionsFn`,
 * see `types/study-reminder.types.ts`). Required by the shared worker —
 * a missing provider fails startup, an unavailable calendar is never
 * treated as an empty one (#424).
 */
export const GET_SESSIONS = Symbol('GET_SESSIONS');
