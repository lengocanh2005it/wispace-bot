import { Logger, Module, type Provider } from '@nestjs/common';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common/redis';
import {
  createWispaceProviders,
  MemoizedWispaceGoalsService,
  RedisWispaceCacheStore,
  WispaceCalendarService,
  WispaceConfigService,
  WispaceDataCache,
  WispaceGoalsService,
  PrecreateExerciseApiClient,
} from '@wispace/wispace-client';

/**
 * Cross-pod WISPACE cache coordination (#568): when Redis is enabled and
 * reachable, cache misses coordinate through it so concurrent pods produce
 * one upstream fetch. Redis disabled/unavailable → in-memory cache only
 * (fail-open, same semantics as the local layer).
 */
function createRedisCacheProvider(): Provider {
  return {
    provide: WispaceDataCache,
    useFactory: (redisClient: RedisClientPort) => {
      const native = redisClient?.getNativeClient();
      const sharedStore =
        redisClient?.isEnabled() && native
          ? new RedisWispaceCacheStore(native, {
              onWarn: (message) =>
                cacheLogger.warn(`Shared store degraded: ${message}`),
            })
          : undefined;
      return new WispaceDataCache({ sharedStore });
    },
    inject: [{ token: REDIS_CLIENT, optional: true }],
  };
}

const cacheLogger = new Logger(WispaceDataCache.name);

/**
 * Messenger's shared WISPACE bindings (#456): the goals memoizer facade over
 * `WispaceDataCache` — one goals fetch per user per TTL window across the
 * reminder, report, and chat-tool paths (mirrors the Discord/Zalo wiring).
 */
@Module({
  providers: [
    ...createWispaceProviders({
      header: 'x-psid',
      cacheProvider: createRedisCacheProvider(),
    }),
    {
      provide: MemoizedWispaceGoalsService,
      useFactory: (
        goalsService: WispaceGoalsService,
        cache: WispaceDataCache,
      ) => new MemoizedWispaceGoalsService(goalsService, cache),
      inject: [WispaceGoalsService, WispaceDataCache],
    },
  ],
  exports: [
    WispaceGoalsService,
    WispaceCalendarService,
    PrecreateExerciseApiClient,
    WispaceConfigService,
    WispaceDataCache,
    MemoizedWispaceGoalsService,
  ],
})
export class WispaceModule {}
