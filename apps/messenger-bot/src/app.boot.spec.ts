import { Test } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './app.module';
import { InternalApiKeyGuard } from '@wispace/bot-common';

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
    process.env.INTERNAL_API_KEY = 'test-internal-key';
    process.env.DB_HOST = 'localhost'; // TLS enforcement — local/private exception
    process.env.WISPACE_INTERNAL_KEY = 'test-wispace-key';
    process.env.WISPACE_API_PRECREATE_EXERCISE_URL =
      'https://testbackend.example.com/precreate-exercise';
    process.env.WISPACE_API_PRECREATE_EXERCISE_TIMEOUT_MS = '30000';
    process.env.CHAT_FREE_FORM_DAILY_LIMIT = '15';
    process.env.CHAT_BURST_PER_MINUTE = '3';
    process.env.CHAT_USAGE_TIMEZONE = 'Asia/Ho_Chi_Minh';
    process.env.STUDY_REMINDER_MINUTES_BEFORE = '30';
    process.env.STUDY_REMINDER_MIN_LEAD_MINUTES = '5';
    process.env.STUDY_REMINDER_SYNC_HORIZON_HOURS = '48';
    process.env.STUDY_REMINDER_MAX_RETRIES = '3';
    process.env.STUDY_REMINDER_RETRY_BACKOFF_MINUTES = '2';
    process.env.STUDY_REMINDER_JOB_RETENTION_DAYS = '7';

    const stubRepo = {} as Repository<unknown>;
    const dataSourceMock = new Proxy({} as DataSource, {
      get: (target, prop, receiver) => {
        if (prop === 'getRepository') return () => stubRepo;
        if (prop === 'getMetadata') return () => ({});
        if (prop === 'manager') {
          return {
            transaction: (fn: unknown) => {
              if (typeof fn === 'function') return (fn as () => unknown)();
              return undefined;
            },
          };
        }
        if (prop === 'options')
          return { entities: [], subscribers: [], migrations: [] };
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

    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();

    await request(app.getHttpServer() as App)
      .get('/health/detail')
      .expect(401);
    await request(app.getHttpServer() as App)
      .get('/health/detail')
      .set('X-Internal-Api-Key', 'wrong-key')
      .expect(401);

    await app.close();
  }, 30_000);
});
