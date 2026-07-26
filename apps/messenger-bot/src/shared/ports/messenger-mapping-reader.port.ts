export const MESSENGER_MAPPING_READER = Symbol('MESSENGER_MAPPING_READER');

export interface UserLink {
  psid?: string;
  userId?: number;
  cadence?: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  topic?: string;
}

export interface MessengerMappingReaderPort {
  findActiveMappingByPsid(psid: string): Promise<UserLink | null>;
  findActiveMappingByUserId(userId: number): Promise<UserLink | null>;
  findActiveMappingsWithPsid(): Promise<UserLink[]>;
}
