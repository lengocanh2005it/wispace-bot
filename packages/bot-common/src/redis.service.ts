import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import type Redis from 'ioredis';
import type { RedisClientPort } from './redis.client.port';

@Injectable()
export class RedisService
  implements RedisClientPort, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private enabled = false;

  constructor(private readonly configService: ConfigService) {
    const raw = this.configService
      .get<string>('REDIS_ENABLED')
      ?.trim()
      .toLowerCase();
    this.enabled = raw === 'true' || raw === '1' || raw === 'yes';
  }

  isEnabled(): boolean {
    return this.enabled && this.client !== null;
  }

  getHost(): string {
    return this.configService.get<string>('REDIS_HOST')?.trim() || '127.0.0.1';
  }

  getPort(): number {
    const raw = this.configService.get<string>('REDIS_PORT')?.trim();
    return raw ? parseInt(raw, 10) || 6379 : 6379;
  }

  getPassword(): string | undefined {
    return (
      this.configService.get<string>('REDIS_PASSWORD')?.trim() || undefined
    );
  }

  getNativeClient(): Redis | null {
    return this.client;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('Redis disabled (REDIS_ENABLED=false)');
      return;
    }

    try {
      const redisTlsEnabled = ['true', '1', 'yes'].includes(
        this.configService.get<string>('REDIS_TLS')?.trim().toLowerCase() ?? '',
      );
      const redisCa = this.configService.get<string>('REDIS_CA')?.trim();

      this.client = new IORedis({
        host: this.getHost(),
        port: this.getPort(),
        password: this.getPassword(),
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => Math.min(times * 200, 3000),
        lazyConnect: true,
        ...(redisTlsEnabled
          ? {
              tls: {
                rejectUnauthorized: true,
                ...(redisCa ? { ca: redisCa } : {}),
              },
            }
          : {}),
      });

      const pong = await this.client.ping();
      this.logger.log(
        `Redis connected host=${this.getHost()} port=${this.getPort()} ping=${pong}`,
      );
    } catch (error) {
      this.logger.error(
        `Redis connection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.client = null;
    }
  }

  async ping(): Promise<string> {
    if (!this.client) return 'NO_REDIS';
    return this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }
}
