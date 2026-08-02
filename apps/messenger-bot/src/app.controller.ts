import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT } from '@wispace/bot-common';
import type { RedisClientPort } from '@wispace/bot-common';

@Controller()
export class AppController {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT)
    private readonly redisClient: RedisClientPort,
  ) {}

  @Get()
  getHello(): string {
    return 'Messenger AI Notification API is running';
  }

  @Get('health/db')
  async checkDatabase() {
    await this.dataSource.query('SELECT 1');
    return { ok: true, database: 'connected', orm: 'typeorm' };
  }

  @Get('health/redis')
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
      message: result,
    });
  }
}
