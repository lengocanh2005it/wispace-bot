import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WispaceCalendarService } from './clients/wispace-calendar.service';
import { WispaceGoalsService } from './clients/wispace-goals.service';
import { PrecreateExerciseApiClient } from './clients/precreate-exercise-api.client';
import { WispaceConfigService } from './config/wispace-config.service';
import { WispaceDataCache } from './cache/wispace-data-cache';
import type { WispaceIdHeader } from './utils/wispace-headers';

export interface WispaceProvidersOptions {
  /** Platform identity header. */
  header: WispaceIdHeader;
  /**
   * Optional sync horizon override. Receives the WispaceConfigService
   * (already created) and returns hours. Default: undefined (= 24h).
   */
  horizonHours?: (configService: WispaceConfigService) => () => number;
  /**
   * Replaces the default in-memory-only `WispaceDataCache` provider — the
   * app wires its Redis-backed shared store here (#568). Must keep the
   * `WispaceDataCache` token.
   */
  cacheProvider?: Provider;
}

/**
 * Creates the 4 standard Wispace DI providers parameterized by platform.
 * Drop-in replacement for the duplicated Discord/Zalo wispace modules.
 */
export function createWispaceProviders(
  options: WispaceProvidersOptions,
): Provider[] {
  const defaultCacheProvider: Provider = {
    // One cache instance per app — chat tools and the report pipeline share
    // it so a bot-side mutation invalidates every consumer's view (#636).
    // Cross-pod shared-store wiring (#568) lives in the app modules, which
    // own the Redis client DI token.
    provide: WispaceDataCache,
    useFactory: () => new WispaceDataCache(),
  };

  return [
    {
      provide: WispaceConfigService,
      useFactory: (configService: ConfigService) =>
        new WispaceConfigService((key) => configService.get<string>(key)),
      inject: [ConfigService],
    },
    {
      provide: WispaceGoalsService,
      useFactory: (configService: WispaceConfigService) =>
        new WispaceGoalsService(options.header, configService),
      inject: [WispaceConfigService],
    },
    {
      provide: WispaceCalendarService,
      useFactory: (configService: WispaceConfigService) =>
        new WispaceCalendarService(
          options.header,
          configService,
          options.horizonHours?.(configService),
        ),
      inject: [WispaceConfigService],
    },
    {
      provide: PrecreateExerciseApiClient,
      useFactory: (configService: WispaceConfigService) =>
        new PrecreateExerciseApiClient(
          configService.buildPrecreateExerciseClientConfig(),
        ),
      inject: [WispaceConfigService],
    },
    options.cacheProvider ?? defaultCacheProvider,
  ];
}
