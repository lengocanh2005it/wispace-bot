/**
 * The cached user display name, as the messenger chat processor needs it when
 * clearing state for a privacy operation. #1450: the concrete
 * `RedisUserDisplayNameCache` is `@Injectable()` and takes a Redis client, so
 * application code injecting it is a boundary violation. The composition root
 * binds that adapter to this token.
 *
 * The port names the one capability the processor uses. The cache's read path
 * and its write path are not part of it: application code that needs the value
 * should take a name, not a cache.
 */
export interface MessengerUserDisplayNameCachePort {
  /**
   * Drops the entry whether or not it exists. Strict because a privacy
   * cleanup must not be able to fail on an already-absent key.
   */
  delStrict(userId: number): Promise<void>;
}

export const MESSENGER_USER_DISPLAY_NAME_CACHE = Symbol(
  'MESSENGER_USER_DISPLAY_NAME_CACHE',
);
