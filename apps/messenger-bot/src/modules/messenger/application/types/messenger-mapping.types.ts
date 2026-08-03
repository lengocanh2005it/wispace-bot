import type { UserMessengerMapping } from '../../domain/entities/messenger.types';

export interface RelinkMappingResult {
  mapping: UserMessengerMapping;
  relinked: boolean;
  blocked?: boolean;
  previousUserId?: number;
  syncedStudyReminders: boolean;
}
