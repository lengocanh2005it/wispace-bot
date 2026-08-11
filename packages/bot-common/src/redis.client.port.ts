import type Redis from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

export interface RedisClientPort {
  isEnabled(): boolean;
  /**
   * True when REDIS_ENABLED=true regardless of connection state — lets health
   * checks report 'error' (503) instead of a misleading 'disabled' when Redis
   * is configured but unreachable at boot.
   */
  isConfiguredEnabled(): boolean;
  ping(): Promise<string>;
  getNativeClient(): Redis | null;
}
