export const MESSENGER_WEBHOOK_DEAD_LETTER_REPOSITORY = Symbol(
  'MESSENGER_WEBHOOK_DEAD_LETTER_REPOSITORY',
);

export interface SaveDeadLetterInput {
  psid: string | null;
  messageMid: string | null;
  rawPayload: object;
  errorMessage: string;
}

export interface WebhookDeadLetterRecord {
  id: number;
  psid: string | null;
  messageMid: string | null;
  rawPayload: object;
  errorMessage: string;
  retryCount: number;
  status: 'pending' | 'replayed' | 'abandoned';
  replayedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListPendingForRetryOptions {
  limit: number;
  /** Only entries with updated_at < olderThan are eligible (natural cooldown between retries). */
  olderThan: Date;
  maxRetries: number;
}

export interface MessengerWebhookDeadLetterRepositoryPort {
  save(input: SaveDeadLetterInput): Promise<WebhookDeadLetterRecord>;
  listPendingForRetry(
    opts: ListPendingForRetryOptions,
  ): Promise<WebhookDeadLetterRecord[]>;
  markReplayed(id: number): Promise<void>;
  markAbandoned(id: number, reason: string): Promise<void>;
  incrementRetry(id: number, errorMessage: string): Promise<void>;
  countByStatus(): Promise<Record<string, number>>;
}
