/** The rolling window every burst store buckets on. Redis and Postgres both
 *  read it, so it is not owned by any one backend (#1288 retired the memory
 *  store that used to own it). */
export const CHAT_BURST_WINDOW_MS = 60_000;
