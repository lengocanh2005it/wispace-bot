import type { WispaceApiClientConfig } from '../clients/wispace-client-types';

export type ReengagementPlatform = 'discord' | 'messenger';

export type ReengagementVariant = 'a' | 'b';

export interface ReengagementCandidate {
  userId: string;
  discordId: string | null;
  psid: string | null;
  email: string | null;
  userName: string;
  platform: ReengagementPlatform;
  lastActiveAt: string;
  daysInactive: number;
  variant: ReengagementVariant;
}

export interface ReengagementCandidatesResult {
  totalCandidates: number;
  candidates: ReengagementCandidate[];
}

/**
 * Pre-rendered Discord structs from WISPACE — passed through to discord.js
 * as-is (Discord owns the schema; we only check they are arrays).
 */
export interface ReengagementDiscordPayload {
  embeds: Array<Record<string, unknown>>;
  components: Array<Record<string, unknown>>;
}

export interface ReengagementPayload {
  variant: ReengagementVariant;
  /** Report period label from the backend (e.g. 1-month or all-time). */
  period: string;
  is_fallback: boolean;
  /** Backend-computed report summary — consumed as an opaque object. */
  summary: Record<string, unknown>;
  discord_payload: ReengagementDiscordPayload;
}

export type ReengagementSendStatus = 'SUCCESS' | 'FAILED';

export interface ReengagementMarkSentInput {
  userId: string;
  platform: ReengagementPlatform;
  daysInactive: number;
  variant: ReengagementVariant;
  status: ReengagementSendStatus;
  messageId?: string;
}

export interface ReengagementMarkSentResult {
  success: boolean;
  logId: string | null;
}

export type ReengagementClientConfig = WispaceApiClientConfig;
