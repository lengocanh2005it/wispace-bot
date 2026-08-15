import type { UserLink } from '../types/study-reminder.types';

export const MAPPING_READER = Symbol('MAPPING_READER');

/** One page of active mappings for the full-sync keyset pagination. */
export interface MappingPage {
  items: UserLink[];
  /** Cursor for the next page — the id of the last returned mapping. */
  nextId?: string;
}

export interface MappingPageQuery {
  limit: number;
  afterId?: string;
}

export interface MappingReaderPort {
  findActiveMappingsPage(
    platform: string,
    query: MappingPageQuery,
  ): Promise<MappingPage>;
  findActiveMappingByExternalUserId(
    platform: string,
    externalUserId: string,
  ): Promise<UserLink | null>;
}
