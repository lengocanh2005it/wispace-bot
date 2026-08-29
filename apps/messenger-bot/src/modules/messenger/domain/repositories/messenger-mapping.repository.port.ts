import {
  NotificationCadence,
  UserMessengerMapping,
} from '../entities/messenger.types';
import type { PlatformLinkState } from '@wispace/contracts';

export interface MessengerMappingRepositoryPort {
  findActiveMappingByPsid(psid: string): Promise<UserMessengerMapping | null>;
  findMappingStateByPsid(psid: string): Promise<PlatformLinkState | null>;
  findActiveMappingByUserId(
    userId: number,
  ): Promise<UserMessengerMapping | null>;
  upsertPsidUserLink(params: {
    psid: string;
    userId: number;
    topic?: string;
    cadence?: NotificationCadence;
    expectedGeneration?: string;
  }): Promise<UserMessengerMapping | null>;
  findActiveSubscribedMappings(): Promise<UserMessengerMapping[]>;
  findActiveSubscribedMappingsPage(
    afterId: number,
    limit: number,
  ): Promise<UserMessengerMapping[]>;
  findActiveMappingsPage(
    afterId: number,
    limit: number,
  ): Promise<UserMessengerMapping[]>;
  cleanupActiveDuplicateMappings(): Promise<number>;
  deactivateConflictingActiveMappings(params: {
    psid: string;
    userId: number;
  }): Promise<void>;
}
