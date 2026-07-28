import type Redis from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

export interface RedisClientPort {
  isEnabled(): boolean;
  ping(): Promise<string>;
  getNativeClient(): Redis | null;
}
