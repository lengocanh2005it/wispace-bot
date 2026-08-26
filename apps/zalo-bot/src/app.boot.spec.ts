import { Test } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from './app.module';
import { InternalApiKeyGuard } from '@wispace/bot-common';
import { PrecreateExerciseApiClient } from '@wispace/wispace-client';

/**
 * Boot smoke test: compiles AppModule and runs app.init() so Nest resolves
 * the whole DI graph. Catches wiring errors (missing providers, exports of
 * unowned tokens, inject/constructor mismatches) that typecheck cannot see
 * and that otherwise only surface at the deploy health check.
 */
describe('AppModule boot smoke', () => {
  it('boots without DI errors', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_MODEL = 'test-model';
    process.env.DB_HOST = 'localhost';
    process.env.DB_PORT = '5432';
    process.env.DB_USER = 'test';
    process.env.DB_PASSWORD = 'test';
    process.env.DB_NAME = 'test';
    process.env.WISPACE_INTERNAL_KEY = 'test-wispace-key';
    process.env.WISPACE_API_PRECREATE_EXERCISE_URL =
      'https://testbackend.example.com/precreate-exercise';
    process.env.WISPACE_API_PRECREATE_EXERCISE_TIMEOUT_MS = '30000';
    process.env.INTERNAL_API_KEY = 'test-internal-key';

    const stubRepo = {} as Repository<unknown>;
    const dataSourceMock = new Proxy({} as DataSource, {
      get: (target, prop, receiver) => {
        if (prop === 'getRepository') return () => stubRepo;
        if (prop === 'getTreeRepository') return () => stubRepo;
        if (prop === 'getMongoRepository') return () => stubRepo;
        if (prop === 'getMetadata') return () => ({});
        if (prop === 'manager') {
          return {
            transaction: (fn: unknown) => {
              if (typeof fn === 'function') return (fn as () => unknown)();
              return undefined;
            },
          };
        }
        if (prop === 'options') {
          return {
            entities: [],
            subscribers: [],
            migrations: [],
            type: 'postgres',
          };
        }
        if (prop === 'entityMetadatas') return [];
        if (prop === 'createQueryRunner') {
          return () => ({
            connect: () => Promise.resolve(),
            release: () => Promise.resolve(),
            query: () => Promise.resolve([{ acquired: false }]),
          });
        }
        if (prop === 'initialize') return () => Promise.resolve(dataSourceMock);
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource)
      .useValue(dataSourceMock)
      .compile();

    expect(moduleRef.get(InternalApiKeyGuard)).toBeInstanceOf(
      InternalApiKeyGuard,
    );
    expect(moduleRef.get(PrecreateExerciseApiClient)).toBeInstanceOf(
      PrecreateExerciseApiClient,
    );

    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    await app.close();
  }, 30_000);

  it('throws when INTERNAL_API_KEY is missing', async () => {
    const saved = process.env.INTERNAL_API_KEY;
    try {
      delete process.env.INTERNAL_API_KEY;
      process.env.DB_HOST = 'localhost';
      process.env.DB_PORT = '5432';
      process.env.DB_USER = 'test';
      process.env.DB_PASSWORD = 'test';
      process.env.DB_NAME = 'test';

      await expect(
        Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(DataSource)
          .useValue({})
          .compile(),
      ).rejects.toThrow();
    } finally {
      if (saved !== undefined) process.env.INTERNAL_API_KEY = saved;
    }
  }, 30_000);
});
