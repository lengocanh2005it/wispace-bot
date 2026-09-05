import {
  Controller,
  Get,
  Inject,
  Logger,
  Optional,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { InternalApiKeyGuard } from '../guard/internal-api-key.guard';
import { REDIS_CLIENT, type RedisClientPort } from '../redis/redis.client.port';
import { errorMessage } from '../masking/error-message';
import { assertPostgresWriter } from './postgres-writer';
import {
  createUnavailablePlatformSnapshot,
  PLATFORM_CONNECTIVITY,
  type PlatformConnectivityPort,
  type PlatformConnectivitySnapshot,
} from './platform-connectivity';

export interface HealthDetail {
  status: 'ok' | 'error';
  database: 'connected' | 'disconnected' | 'unknown';
  redis: 'connected' | 'disabled' | 'error' | 'unreachable' | 'unknown';
  platform?: PlatformConnectivitySnapshot;
  [key: string]: unknown;
}

export const OPS_HEALTH_SERVICE = Symbol('OPS_HEALTH_SERVICE');

export interface OpsHealthServicePort {
  collectSnapshot(
    platformSnapshot?: PlatformConnectivitySnapshot,
  ): Promise<Record<string, unknown>>;
  isApplicationReady(platformSnapshot?: PlatformConnectivitySnapshot): Promise<{
    ready: boolean;
    status: string;
    reason?: string;
  }>;
}

/**
 * Health endpoints shared by all WISPACE bots — consolidated from the
 * per-app controllers (unified on the richer behavior: DB error detail +
 * Redis `isEnabled()` guard).
 *
 * Route semantics (identical across Messenger/Discord/Zalo):
 * - `GET /health`        — public liveness: process is up. Returns a generic
 *   payload only; never exposes DB/Redis/config/version details to external
 *   probes or load balancers.
 * - `GET /health/ready`  — public readiness: 200 only when DB, configured
 *   Redis, platform connectivity, and other readiness checks pass. The
 *   platform snapshot is cached; this route never calls a vendor API.
 * - `GET /health/detail` — internal (requires `X-Internal-Api-Key`): full
 *   DB/Redis/platform detail for ops debugging.
 */
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT) private readonly redisClient: RedisClientPort,
    @Optional()
    @Inject(OPS_HEALTH_SERVICE)
    private readonly opsHealthService?: OpsHealthServicePort,
    @Optional()
    @Inject(PLATFORM_CONNECTIVITY)
    private readonly platformConnectivity?: PlatformConnectivityPort,
  ) {}

  /**
   * Public liveness — generic process health only. Never 503s and never
   * leaks dependency details (load balancer / k8s liveness probe).
   */
  @Get()
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Public readiness — 200 only when every configured dependency is
   * reachable. Status-only response: the 503 body carries no details about
   * which dependency failed (deploy gates / k8s readiness probe).
   */
  @Get('ready')
  async readiness(): Promise<{ status: 'ok' }> {
    if (this.opsHealthService) {
      const readyResult = await this.opsHealthService.isApplicationReady(
        this.getPlatformSnapshot(),
      );
      if (!readyResult.ready) {
        this.logger.warn(
          `Application readiness failed: ${readyResult.reason ?? 'unknown'}`,
        );
        throw new ServiceUnavailableException({ status: 'error' });
      }
      return { status: 'ok' };
    }

    const detail = await this.checkDetail();
    if (detail.status === 'error') {
      throw new ServiceUnavailableException({ status: 'error' });
    }
    return { status: 'ok' };
  }

  /**
   * Internal readiness detail — full DB/Redis status for ops. Guarded by
   * `InternalApiKeyGuard`; public probes must use `/health/ready`.
   */
  @Get('detail')
  @UseGuards(InternalApiKeyGuard)
  async detail(): Promise<HealthDetail | Record<string, unknown>> {
    if (this.opsHealthService) {
      return this.opsHealthService.collectSnapshot(this.getPlatformSnapshot());
    }
    return this.checkDetail();
  }

  private getPlatformSnapshot(): PlatformConnectivitySnapshot {
    return (
      this.platformConnectivity?.getSnapshot() ??
      createUnavailablePlatformSnapshot()
    );
  }

  private async checkDetail(): Promise<HealthDetail> {
    const result: HealthDetail = {
      status: 'ok',
      database: 'unknown',
      redis: 'unknown',
    };

    if (this.platformConnectivity) {
      result.platform = this.getPlatformSnapshot();
      if (!result.platform.ready) {
        result.status = 'error';
      }
    }

    // DB check
    try {
      await assertPostgresWriter(this.dataSource);
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

    return result;
  }
}
