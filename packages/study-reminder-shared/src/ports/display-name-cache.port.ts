export const DISPLAY_NAME_CACHE = Symbol('DISPLAY_NAME_CACHE');

export interface DisplayNameCachePort {
  getDisplayName(userId: number): Promise<string | null>;
  setDisplayName(userId: number, displayName: string): Promise<void>;
}
