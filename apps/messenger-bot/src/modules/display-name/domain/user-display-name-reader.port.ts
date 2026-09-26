export const USER_DISPLAY_NAME_READER = Symbol('USER_DISPLAY_NAME_READER');

export interface UserDisplayNameRecord {
  id: number;
  displayName: string | null;
  username: string | null;
}

/**
 * Reader seam for the `"Users"` view projection. The current view mapping
 * stays in the TypeORM adapter; application policy only sees these fields.
 */
export interface UserDisplayNameReaderPort {
  findByIds(userIds: number[]): Promise<UserDisplayNameRecord[]>;
  findById(userId: number): Promise<UserDisplayNameRecord | null>;
}
