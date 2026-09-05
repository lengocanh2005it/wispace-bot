import { Logger, Module, type Provider } from '@nestjs/common';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common/redis';
import {
  createWispaceProviders,
  RedisWispaceCacheStore,
  WispaceCalendarService,
  WispaceConfigService,
  WispaceDataCache,
  WispaceGoalsService,
  PrecreateExerciseApiClient,
} from '@wispace/wispace-client';
import { PlatformStudyCalendarCommandService } from '@wispace/study-reminder-shared';
import { BotMetricsService } from '@wispace/bot-metrics';

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

@Module({
  providers: [
    ...createWispaceProviders({
      header: 'x-discordid',
      metrics: BotMetricsService,
      horizonHours: (configService) => () =>
        configService.getSyncHorizonHours(),
      cacheProvider: createRedisCacheProvider(),
    }),
    {
      provide: PlatformStudyCalendarCommandService,
      useFactory: (
        calendarService: WispaceCalendarService,
        configService: WispaceConfigService,
      ) =>
        new PlatformStudyCalendarCommandService(
          { platform: 'discord', enforceLeadTime: true },
          calendarService,
          configService,
        ),
      inject: [WispaceCalendarService, WispaceConfigService],
    },
  ],
  exports: [
    WispaceGoalsService,
    WispaceCalendarService,
    PrecreateExerciseApiClient,
    WispaceConfigService,
    WispaceDataCache,
    PlatformStudyCalendarCommandService,
  ],
})
export class WispaceModule {}
