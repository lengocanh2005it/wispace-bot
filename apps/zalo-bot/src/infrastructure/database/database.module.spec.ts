import { ConfigService } from '@nestjs/config';
import {
  DB_CIRCUIT_BREAKER_METRICS,
  WebhookInboundEventEntity,
} from '@wispace/database';
import { BotMetricsService } from '@wispace/bot-metrics';
import { buildTypeOrmOptions, DatabaseModule } from './database.module';

describe('Zalo DatabaseModule', () => {
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

  it('registers durable webhook inbox entity with TypeORM', () => {
    const config = new ConfigService({
      DB_HOST: 'localhost',
      DB_PORT: '5432',
      DB_USER: 'test',
      DB_PASSWORD: 'test',
      DB_NAME: 'test',
    });

    const options = buildTypeOrmOptions(config);

    expect(options.entities).toContain(WebhookInboundEventEntity);
  });
});
