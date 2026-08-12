import { Test } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import { Client } from 'discord.js';
import { AppModule } from './app.module';
import { InternalApiKeyGuard } from '@wispace/bot-common';

/**
 * Boot smoke test: compiles AppModule and runs app.init() so Nest resolves
 * the whole DI graph. Catches wiring errors (missing providers, exports of
 * unowned tokens, inject/constructor mismatches) that typecheck cannot see
 * and that otherwise only surface at the deploy health check.
 *
 * Client.login is mocked so no Discord websocket connection is attempted;
 * the advisory-lock mock returns "not acquired" so startup sync crons are
 * no-ops.
 */
describe('AppModule boot smoke', () => {
  it('boots without DI errors', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_MODEL = 'test-model';
    process.env.DISCORD_BOT_TOKEN = 'fake-token';
    process.env.CHAT_FREE_FORM_DAILY_LIMIT = '15';
    process.env.CHAT_BURST_PER_MINUTE = '3';
    process.env.CHAT_USAGE_TIMEZONE = 'Asia/Ho_Chi_Minh';
    const loginSpy = jest
      .spyOn(Client.prototype, 'login')
      .mockResolvedValue('fake-token');

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

    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    await app.close();

    loginSpy.mockRestore();
  }, 30_000);
});
