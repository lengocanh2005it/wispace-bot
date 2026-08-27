import { Module, type DynamicModule, Global } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common/redis';
import { OPS_HEALTH_SERVICE as BOT_COMMON_OPS_HEALTH_SERVICE } from '@wispace/bot-common/health';
import { CronHeartbeatRegistry } from './cron-heartbeat-registry';
import { OpsHealthService } from './ops-health.service';
import { TypeormOpsHealthRepository } from './typeorm-ops-health.repository';
import {
  CRON_HEARTBEAT_REGISTRY,
  OPS_HEALTH_REPOSITORY,
  OPS_HEALTH_SERVICE,
  type OpsHealthRepositoryPort,
} from './types';

@Global()
@Module({})
export class OpsHealthModule {
  static forPlatform(platform: string): DynamicModule {
    return {
      module: OpsHealthModule,
      imports: [ConfigModule],
      providers: [
        CronHeartbeatRegistry,
        {
          provide: CRON_HEARTBEAT_REGISTRY,
          useExisting: CronHeartbeatRegistry,
        },
        {
          provide: OPS_HEALTH_REPOSITORY,
          useFactory: (dataSource: DataSource) =>
            new TypeormOpsHealthRepository(dataSource, platform),
          inject: [DataSource],
        },
        {
          provide: OPS_HEALTH_SERVICE,
          useFactory: (
            repo: OpsHealthRepositoryPort,
            configService: ConfigService,
            registry: CronHeartbeatRegistry,
            redisClient?: RedisClientPort,
          ) => new OpsHealthService(repo, configService, registry, redisClient),
          inject: [
            OPS_HEALTH_REPOSITORY,
            ConfigService,
            CronHeartbeatRegistry,
            { token: REDIS_CLIENT, optional: true },
          ],
        },
        {
          provide: BOT_COMMON_OPS_HEALTH_SERVICE,
          useExisting: OPS_HEALTH_SERVICE,
        },
        {
          provide: OpsHealthService,
          useExisting: OPS_HEALTH_SERVICE,
        },
      ],
      exports: [
        CronHeartbeatRegistry,
        CRON_HEARTBEAT_REGISTRY,
        OPS_HEALTH_REPOSITORY,
        OPS_HEALTH_SERVICE,
        BOT_COMMON_OPS_HEALTH_SERVICE,
        OpsHealthService,
      ],
    };
  }
}
