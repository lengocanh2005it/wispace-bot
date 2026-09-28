import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { DynamicModule, InjectionToken } from '@nestjs/common';
import { NOTIFICATION_PREFERENCE } from '@wispace/contracts';
import { CanonicalPlatformService } from './services/cross-cutting/canonical-platform.service';
import { WebActivityService } from './services/cross-cutting/web-activity.service';
import {
  DB_CIRCUIT_BREAKER_METRICS,
  DbCircuitBreakerService,
} from './db-circuit-breaker';
import { NotificationPreferenceService } from './services/metering-and-operations/notification-preference.service';
import { PrivacyDataService } from './services/metering-and-operations/privacy-data.service';
import { PrivacyCleanupJobStore } from './services/metering-and-operations/privacy-cleanup-job.service';
import type { PrivacyEntityRegistry } from './services/metering-and-operations/privacy-data.service';

type Providers = NonNullable<DynamicModule['providers']>;
type Exports = NonNullable<DynamicModule['exports']>;

export interface PlatformDatabaseProvidersOptions {
  /**
   * The app's metrics class, passed in rather than imported.
   * `@wispace/bot-metrics` is a documented forbidden dependency of this
   * package (`DATABASE_FORBIDDEN_DEPENDENCIES` in
   * `scripts/check-architecture.mjs`), so the caller hands the token over and
   * this package never names it.
   */
  circuitBreakerMetrics: InjectionToken;
  /**
   * Each app keeps its own `buildPrivacyEntityRegistry()` because
   * `scripts/database-privacy-smoke.mjs` exercises the registry the app really
   * wires. Called per resolve rather than captured, so a test that swaps the
   * registry still takes effect.
   */
  privacyEntityRegistry: () => PrivacyEntityRegistry;
}

/**
 * The provider graph every bot's `DatabaseModule` wires. It was three
 * byte-identical copies differing only in which entity list
 * `TypeOrmModule.forFeature` received, so a change to the privacy wiring had to
 * be made three times — and could be made twice.
 */
export function buildPlatformDatabaseProviders(
  options: PlatformDatabaseProvidersOptions,
): Providers {
  const { circuitBreakerMetrics, privacyEntityRegistry } = options;

  return [
    DbCircuitBreakerService,
    {
      provide: DB_CIRCUIT_BREAKER_METRICS,
      useExisting: circuitBreakerMetrics,
    },
    CanonicalPlatformService,
    NotificationPreferenceService,
    {
      provide: NOTIFICATION_PREFERENCE,
      useExisting: NotificationPreferenceService,
    },
    WebActivityService,
    {
      provide: PrivacyCleanupJobStore,
      useFactory: (dataSource: DataSource) =>
        new PrivacyCleanupJobStore(dataSource),
      inject: [DataSource],
    },
    {
      provide: PrivacyDataService,
      useFactory: (
        dataSource: DataSource,
        cleanupJobs: PrivacyCleanupJobStore,
      ) =>
        new PrivacyDataService(
          dataSource,
          privacyEntityRegistry(),
          cleanupJobs,
        ),
      inject: [DataSource, PrivacyCleanupJobStore],
    },
  ];
}

/**
 * The matching export list. `TypeOrmModule` is here because every app
 * re-exported it, so feature modules can reach the repositories registered by
 * `forFeature`.
 */
export const PLATFORM_DATABASE_EXPORTS: Exports = [
  TypeOrmModule,
  CanonicalPlatformService,
  NotificationPreferenceService,
  NOTIFICATION_PREFERENCE,
  WebActivityService,
  PrivacyCleanupJobStore,
  PrivacyDataService,
];
