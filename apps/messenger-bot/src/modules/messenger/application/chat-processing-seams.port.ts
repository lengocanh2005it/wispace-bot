import type { ChatHistoryMessage } from '@wispace/chat-pipeline';
import {
  PRIVACY_CLEANUP_STORES,
  type PrivacyCleanupStore,
  type PrivacyDataPort,
  type PrivacyDeleteResult,
  type PrivacyExpectedMapping,
  type PrivacyStateCleanup,
  type PrivacyUnlinkResult,
} from '@wispace/contracts';
import type { PrivacyIntent } from '@wispace/llm-agent/core';

export { PRIVACY_CLEANUP_STORES };
export type {
  PrivacyCleanupStore,
  PrivacyDataPort,
  PrivacyDeleteResult,
  PrivacyExpectedMapping,
  PrivacyStateCleanup,
  PrivacyUnlinkResult,
};

/**
 * Seams the Messenger chat processor owns (#1088). Each shape mirrors the
 * concrete adapter it replaces, minus the framework wiring: the TypeORM
 * privacy service, the Redis/Config chat history service and the in-memory
 * privacy confirmation state stay in infrastructure and are bound to these
 * tokens in `chat-pipeline.module.ts`.
 */

/**
 * The in-flight privacy confirmation ("are you sure you want to unlink?").
 * Durable consent snapshots the mapping identity it was armed with, so a
 * relink invalidates the pending action instead of executing it.
 */
export interface PrivacyStatePort {
  getPendingAction(
    psid: string,
    platform: string,
    identity?: { userId?: number; mappingGeneration?: string },
  ): PrivacyIntent;
  setPendingAction(
    psid: string,
    platform: string,
    intent: PrivacyIntent,
    identity?: { userId?: number; mappingGeneration?: string },
  ): string;
  clearPendingAction(psid: string, platform: string): void;
}

export const PRIVACY_STATE = Symbol('PRIVACY_STATE');

/**
 * The privacy stores a bot owns: history, queue, clarification state and the
 * display-name cache. Mirrors `PRIVACY_CLEANUP_STORES` so a store set is never
 * silently invented at this boundary — the service asserts one callback per
 * configured store before any irreversible write.
 */
/** Chat-history reads/writes used by the processor and pipeline (#1088). */
export interface ChatHistoryPort {
  getHistory(externalUserId: string): Promise<ChatHistoryMessage[]>;
  appendTurn(
    externalUserId: string,
    userText: string,
    assistantText: string,
  ): Promise<void>;
  appendToolSummary(externalUserId: string, summary: string): Promise<void>;
  clear(externalUserId: string): Promise<void>;
}

export const CHAT_HISTORY = Symbol('CHAT_HISTORY');
export const PRIVACY_DATA = Symbol('PRIVACY_DATA');

/**
 * The four resolved chat-flush numbers the processor branches on, snapshotted
 * by the module. The processor must not read env vars itself: one module owns
 * the resolution (`ChatRuntimeConfig` + `readChatFlushRetrySettings`) so the
 * values cannot drift between the queue worker and the processor.
 */
export interface ChatFlushSettings {
  /** Redis queue debounce window; a claimed batch younger than this waits. */
  debounceMs: number;
  /** A claimed batch older than this is treated as stuck and reclaimable. */
  processingStuckMs: number;
  /** Schedule a retry flush after a lost/temporarily-unknown lease. */
  retryEnabled: boolean;
  retryDelayMs: number;
}

export const CHAT_FLUSH_SETTINGS = Symbol('CHAT_FLUSH_SETTINGS');
