import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (configService: ConfigService): Redis | null => {
        const enabled =
          configService.get<string>('REDIS_ENABLED')?.toLowerCase() === 'true';
        if (!enabled) return null;

        return new Redis({
          host: configService.get<string>('REDIS_HOST') ?? 'localhost',
          port: Number(configService.get<string>('REDIS_PORT') ?? 6379),
          password: configService.get<string>('REDIS_PASSWORD') || undefined,
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          connectTimeout: 5_000,
          enableOfflineQueue: false,
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
