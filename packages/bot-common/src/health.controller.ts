import {
  Controller,
  Get,
  Inject,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { REDIS_CLIENT, type RedisClientPort } from './redis.client.port';

/**
 * Health endpoints shared by all WISPACE bots — consolidated from the
 * per-app controllers (unified on the richer behavior: DB error detail +
 * Redis `isEnabled()` guard).
 */
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT) private readonly redisClient: RedisClientPort,
  ) {}

  @Get()
  async check(): Promise<{ status: string; database: string }> {
    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'ok', database: 'connected' };
    } catch (error) {
      this.logger.warn(
        `Health check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException({
        status: 'error',
        database: 'disconnected',
      });
    }
  }

  @Get('redis')
  async checkRedis() {
    if (!this.redisClient.isEnabled()) {
      return { ok: true, redis: 'disabled' };
    }
    try {
      const result: string = await this.redisClient.ping();
      if (result === 'PONG') return { ok: true, redis: 'connected' };
      this.logger.warn(`Redis health check failed: unexpected response`);
      throw new ServiceUnavailableException({
        ok: false,
        redis: 'error',
      });
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      this.logger.warn(
        `Redis health check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException({
        ok: false,
        redis: 'unreachable',
      });
    }
  }
}
