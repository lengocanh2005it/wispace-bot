import {
  NotificationCadence,
  UserMessengerMapping,
} from '../entities/messenger.types';

export const MESSENGER_MAPPING_REPOSITORY = Symbol(
  'MESSENGER_MAPPING_REPOSITORY',
);

export interface MessengerMappingRepositoryPort {
  findActiveMappingByPsid(psid: string): Promise<UserMessengerMapping | null>;
  findActiveMappingByUserId(
    userId: number,
  ): Promise<UserMessengerMapping | null>;
  upsertPsidUserLink(params: {
    psid: string;
    userId: number;
    topic?: string;
    cadence?: NotificationCadence;
  }): Promise<UserMessengerMapping>;
  upsertPocSubscription(params: {
    psid: string;
    userId: number;
    cadence: NotificationCadence;
    topic: string;
    notificationMessagesToken: string;
  }): Promise<UserMessengerMapping>;
  findActiveSubscribedMappings(): Promise<UserMessengerMapping[]>;
  findActiveMappingsWithPsid(): Promise<UserMessengerMapping[]>;
  cleanupActiveDuplicateMappings(): Promise<number>;
  deactivateConflictingActiveMappings(params: {
    psid: string;
    userId: number;
  }): Promise<void>;
}
