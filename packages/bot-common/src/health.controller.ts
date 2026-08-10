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
import { errorMessage } from './error-message';

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

  /**
   * Combined health endpoint — checks both DB and Redis.
   * Use this for load balancers / k8s probes.
   */
  @Get()
  async check(): Promise<{
    status: string;
    database: string;
    redis: string;
  }> {
    const result: { status: string; database: string; redis: string } = {
      status: 'ok',
      database: 'unknown',
      redis: 'unknown',
    };

    // DB check
    try {
      await this.dataSource.query('SELECT 1');
      result.database = 'connected';
    } catch (error) {
      this.logger.warn(`Health check DB failed: ${errorMessage(error)}`);
      result.database = 'disconnected';
      result.status = 'error';
    }

    // Redis check — a configured-but-unreachable Redis at boot is an ERROR,
    // not "disabled" (deploy health gates would otherwise go green degraded).
    if (!this.redisClient.isConfiguredEnabled()) {
      result.redis = 'disabled';
    } else if (!this.redisClient.isEnabled()) {
      this.logger.warn(
        'Redis health check failed: configured (REDIS_ENABLED=true) but not connected',
      );
      result.redis = 'error';
      result.status = 'error';
    } else {
      try {
        const pingResult: string = await this.redisClient.ping();
        result.redis = pingResult === 'PONG' ? 'connected' : 'error';
        if (result.redis !== 'connected') {
          result.status = 'error';
        }
      } catch (error) {
        this.logger.warn(`Health check Redis failed: ${errorMessage(error)}`);
        result.redis = 'unreachable';
        result.status = 'error';
      }
    }

    if (result.status === 'error') {
      throw new ServiceUnavailableException({ status: 'error' });
    }

    return result;
  }

  @Get('redis')
  async checkRedis() {
    if (!this.redisClient.isConfiguredEnabled()) {
      return { ok: true, redis: 'disabled' };
    }
    if (!this.redisClient.isEnabled()) {
      this.logger.warn(
        'Redis health check failed: configured (REDIS_ENABLED=true) but not connected',
      );
      throw new ServiceUnavailableException({
        ok: false,
        redis: 'error',
      });
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
      this.logger.warn(`Redis health check failed: ${errorMessage(error)}`);
      throw new ServiceUnavailableException({
        ok: false,
        redis: 'unreachable',
      });
    }
  }
}
