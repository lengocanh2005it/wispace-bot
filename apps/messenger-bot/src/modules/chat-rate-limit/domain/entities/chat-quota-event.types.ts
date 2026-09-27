import type {
  ChatQuotaDenyReason,
  ChatQuotaReleaseReason,
} from '@wispace/contracts';

export interface ChatQuotaReservedPayload {
  limit: number;
  used_after: number;
  idempotency_key: string;
}

export interface ChatQuotaReleasedPayload {
  reason: ChatQuotaReleaseReason;
  used_after: number;
}

export interface ChatQuotaDeniedPayload {
  reason: ChatQuotaDenyReason;
  limit: number;
  used: number;
}
