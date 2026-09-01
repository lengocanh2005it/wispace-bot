import { Global, Module } from '@nestjs/common';
import { REDIS_CLIENT } from './redis.client.port';
import { OutboundRateLimiter } from './outbound-rate-limiter';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [
    RedisService,
    OutboundRateLimiter,
    {
      provide: REDIS_CLIENT,
      useExisting: RedisService,
    },
  ],
  exports: [RedisService, REDIS_CLIENT, OutboundRateLimiter],
})
export class RedisModule {}
