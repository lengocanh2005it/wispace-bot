import { Global, Module } from '@nestjs/common';
import { REDIS_CLIENT } from './redis.client.port';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [
    RedisService,
    {
      provide: REDIS_CLIENT,
      useExisting: RedisService,
    },
  ],
  exports: [RedisService, REDIS_CLIENT],
})
export class RedisModule {}
