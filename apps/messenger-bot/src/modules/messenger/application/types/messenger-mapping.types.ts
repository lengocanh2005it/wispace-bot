import type { UserMessengerMapping } from '../../domain/entities/messenger.types';

export interface RelinkMappingResult {
  mapping?: UserMessengerMapping;
  relinked: boolean;
  blocked?: boolean;
  intentOutcome?:
    | 'claimed'
    | 'committed'
    | 'already_processing'
    | 'already_committed'
    | 'stale'
    | 'claim_failed'
    | 'complete_failed';
  previousUserId?: number;
  syncedStudyReminders: boolean;
}
