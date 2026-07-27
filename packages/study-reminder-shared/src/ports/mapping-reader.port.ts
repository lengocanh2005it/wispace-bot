import type { UserLink } from '../types/study-reminder.types';

export const MAPPING_READER = Symbol('MAPPING_READER');

export interface MappingReaderPort {
  findActiveMappings(platform: string): Promise<UserLink[]>;
  findActiveMappingByExternalUserId(
    platform: string,
    externalUserId: string,
  ): Promise<UserLink | null>;
}
