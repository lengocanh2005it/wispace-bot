import type { CachedUserDisplayName } from '@wispace/bot-common';

export type { CachedUserDisplayName };

export const USER_DISPLAY_NAME_CACHE = Symbol('USER_DISPLAY_NAME_CACHE');

export interface UserDisplayNameCachePort {
  isAvailable(): boolean;
  get(userId: number): Promise<CachedUserDisplayName | null>;
  set(userId: number, value: CachedUserDisplayName): Promise<void>;
}
