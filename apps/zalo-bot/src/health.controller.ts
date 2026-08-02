import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { REDIS_CLIENT } from '@wispace/bot-common';
import type { RedisClientPort } from '@wispace/bot-common';

@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT)
    private readonly redisClient: RedisClientPort,
  ) {}

  @Get()
  async check(): Promise<{ status: string; database: string }> {
    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'ok', database: 'connected' };
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        database: 'disconnected',
        message: 'database unavailable',
      });
    }
  }

  @Get('redis')
  async checkRedis() {
    const result = await this.redisClient.ping();
    if (result === 'NO_REDIS') {
      return { ok: true, redis: 'disabled' };
    }
    if (result === 'PONG') {
      return { ok: true, redis: 'connected' };
    }
    throw new ServiceUnavailableException({
      ok: false,
      redis: 'error',
      message: 'redis unavailable',
    });
  }
}
