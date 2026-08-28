import CircuitBreaker from 'opossum';
import { DataSource, DataSourceOptions } from 'typeorm';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { BotMetricsService } from '@wispace/bot-metrics';
import {
  readEnv,
  readMigrationLockId,
  type EnvSource,
} from './typeorm-options';
import { guardDataSourceMigrations } from './migration-data-source';

export interface DbCircuitBreakerOptions {
  enabled?: boolean;
  threshold?: number;
  errorThresholdPercentage?: number;
  resetTimeoutMs?: number;
  timeoutMs?: number;
}

export interface CircuitBreakerProtectedDataSource extends DataSource {
  _dbCircuitBreaker?: CircuitBreaker;
}

const logger = new Logger('DbCircuitBreaker');

/**
 * Read database circuit breaker configuration from environment/ConfigService.
 */
export function readDbCircuitBreakerOptions(
  source: EnvSource,
): DbCircuitBreakerOptions {
  const enabledStr = readEnv(source, 'DB_CIRCUIT_BREAKER_ENABLED');
  const enabled = enabledStr !== undefined ? enabledStr !== 'false' : true;

  const thresholdStr = readEnv(source, 'DB_CIRCUIT_BREAKER_THRESHOLD');
  const threshold = thresholdStr ? Number(thresholdStr) : 5;

  const errorThresholdPercentageStr = readEnv(
    source,
    'DB_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE',
  );
  const errorThresholdPercentage = errorThresholdPercentageStr
    ? Number(errorThresholdPercentageStr)
    : 50;

  const resetTimeoutMsStr = readEnv(
    source,
    'DB_CIRCUIT_BREAKER_RESET_TIMEOUT_MS',
  );
  const resetTimeoutMs = resetTimeoutMsStr ? Number(resetTimeoutMsStr) : 30_000;

  const poolTimeout = Number(
    readEnv(source, 'DB_POOL_CONNECTION_TIMEOUT_MS') ?? 5_000,
  );
  const timeoutMsStr = readEnv(source, 'DB_CIRCUIT_BREAKER_TIMEOUT_MS');
  const timeoutMs = timeoutMsStr ? Number(timeoutMsStr) : poolTimeout + 1_000;

  return {
    enabled,
    threshold,
    errorThresholdPercentage,
    resetTimeoutMs,
    timeoutMs,
  };
}

/**
 * Attach an opossum CircuitBreaker to wrap TypeORM PostgresDriver connection acquisition.
 * When the circuit is OPEN, connection requests fail fast immediately without blocking
 * behind the connection pool timeout.
 */
export function attachDbCircuitBreaker(
  dataSource: DataSource,
  options?: DbCircuitBreakerOptions,
): CircuitBreaker | undefined {
  if (options?.enabled === false) {
    return undefined;
  }

  const driver = dataSource.driver;
  if (!driver || typeof driver.obtainMasterConnection !== 'function') {
    return undefined;
  }

  const existingBreaker = getDbCircuitBreaker(dataSource);
  if (existingBreaker) {
    return existingBreaker;
  }

  const rawObtainMasterConnection = driver.obtainMasterConnection.bind(driver);

  const breaker = new CircuitBreaker(rawObtainMasterConnection, {
    volumeThreshold: options?.threshold ?? 5,
    errorThresholdPercentage: options?.errorThresholdPercentage ?? 50,
    resetTimeout: options?.resetTimeoutMs ?? 30_000,
    timeout: options?.timeoutMs ?? 6_000,
  });

  breaker.on('open', () => {
    logger.warn(
      'PostgreSQL connection pool circuit breaker OPEN — failing fast',
    );
  });
  breaker.on('halfOpen', () => {
    logger.log(
      'PostgreSQL connection pool circuit breaker half-open — testing recovery',
    );
  });
  breaker.on('close', () => {
    logger.log('PostgreSQL connection pool circuit breaker closed — recovered');
  });

  driver.obtainMasterConnection = function () {
    return breaker.fire();
  };

  (dataSource as CircuitBreakerProtectedDataSource)._dbCircuitBreaker = breaker;
  (
    driver as unknown as { _dbCircuitBreaker: CircuitBreaker }
  )._dbCircuitBreaker = breaker;

  return breaker;
}

/**
 * Retrieve the attached CircuitBreaker from a DataSource or its driver if present.
 */
export function getDbCircuitBreaker(
  dataSource: DataSource,
): CircuitBreaker | undefined {
  if (!dataSource) {
    return undefined;
  }
  return (
    (dataSource as CircuitBreakerProtectedDataSource)._dbCircuitBreaker ??
    (
      dataSource.driver as unknown as {
        _dbCircuitBreaker?: CircuitBreaker;
      }
    )?._dbCircuitBreaker
  );
}

/**
 * Factory for TypeOrmModule.forRootAsync dataSourceFactory option that
 * automatically attaches the circuit breaker before initializing the DataSource.
 */
export function createCircuitBreakerDataSourceFactory(source?: EnvSource) {
  return async (options?: DataSourceOptions): Promise<DataSource> => {
    if (!options) {
      throw new Error('DataSourceOptions is required');
    }
    const dataSource = new DataSource(options);
    const configSource = source ?? process.env;
    if (options.migrationsRun) {
      guardDataSourceMigrations(dataSource, readMigrationLockId(configSource));
    }
    const breakerOptions = readDbCircuitBreakerOptions(configSource);
    attachDbCircuitBreaker(dataSource, breakerOptions);
    return dataSource.initialize();
  };
}

/**
 * Shared lifecycle service that registers the database circuit breaker with
 * BotMetricsService on boot when both are present in the NestJS context.
 */
@Injectable()
export class DbCircuitBreakerService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional()
    @Inject(BotMetricsService)
    private readonly metrics?: BotMetricsService,
  ) {}

  onModuleInit(): void {
    const breaker = getDbCircuitBreaker(this.dataSource);
    if (breaker && this.metrics) {
      this.metrics.registerDbCircuitBreaker(breaker);
    }
  }
}
