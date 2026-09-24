import { DB_CIRCUIT_BREAKER_METRICS } from '@wispace/database';
import { BotMetricsService } from '@wispace/bot-metrics';
import { DatabaseModule } from './database.module';

describe('Messenger DatabaseModule', () => {
  it('binds the database circuit-breaker recorder to platform metrics', () => {
    const providers = (Reflect.getMetadata('providers', DatabaseModule) ??
      []) as Array<{ provide?: unknown; useExisting?: unknown }>;
    const binding = providers.find(
      (provider) => provider.provide === DB_CIRCUIT_BREAKER_METRICS,
    );

    expect(binding).toEqual({
      provide: DB_CIRCUIT_BREAKER_METRICS,
      useExisting: BotMetricsService,
    });
  });
});
