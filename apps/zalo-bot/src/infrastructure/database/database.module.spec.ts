import { ConfigService } from '@nestjs/config';
import { WebhookInboundEventEntity } from '@wispace/database';
import { buildTypeOrmOptions } from './database.module';

describe('Zalo DatabaseModule', () => {
  it('registers durable webhook inbox entity with TypeORM', () => {
    const config = {
      get: jest.fn(),
      getOrThrow: jest.fn((key: string) => {
        const values: Record<string, string> = {
          DB_HOST: 'localhost',
          DB_PORT: '5432',
          DB_USER: 'test',
          DB_PASSWORD: 'test',
          DB_NAME: 'test',
        };
        return values[key];
      }),
    } as unknown as ConfigService;

    const options = buildTypeOrmOptions(config);

    expect(options.entities).toContain(WebhookInboundEventEntity);
  });
});
