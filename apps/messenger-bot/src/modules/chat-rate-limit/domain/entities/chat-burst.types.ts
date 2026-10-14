// #1288: the memory store is retired. Postgres is the correctness floor
// (ADR-0007); Redis is the optional HA tier in front of it.
export type ChatBurstStoreKind = 'postgres' | 'redis';

export const CHAT_BURST_WINDOW_MS = 60_000;

export const CHAT_BURST_KEY_TTL_SECONDS = 120;
