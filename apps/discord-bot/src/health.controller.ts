import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { REDIS_CLIENT } from './infrastructure/redis/redis.module';

@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    @Inject(REDIS_CLIENT) private readonly redisClient: any,
  ) {}

  @Get()
  async check(): Promise<{ status: string; database: string }> {
    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'ok', database: 'connected' };
    } catch (error) {
      throw new ServiceUnavailableException({
        status: 'error',
        database: 'disconnected',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  @Get('redis')
  async checkRedis() {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    const result: string = await this.redisClient.ping();
    if (result === 'NO_REDIS') return { ok: true, redis: 'disabled' };
    if (result === 'PONG') return { ok: true, redis: 'connected' };
    throw new ServiceUnavailableException({
      ok: false,
      redis: 'error',
      message: result,
    });
  }
}
