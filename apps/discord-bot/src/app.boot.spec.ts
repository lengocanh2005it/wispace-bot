import { Test } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import { Client } from 'discord.js';
import { AppModule } from './app.module';
import { InternalApiKeyGuard } from '@wispace/bot-common/guard';
import { PrecreateExerciseApiClient } from '@wispace/wispace-client';
import { DiscordAccountLinkService } from './modules/account-link/application/services/discord-account-link.service';
import { DiscordLinkCompletionService } from './modules/account-link/application/services/discord-link-completion.service';
import { DiscordOauthStateService } from './modules/account-link/application/services/discord-oauth-state.service';

const initialEnv = { ...process.env };

afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...initialEnv };
});

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
  it('boots and resolves representative providers without DI errors', async () => {
    process.env.NODE_ENV = 'test';
    process.env.REDIS_ENABLED = 'false';
    process.env.DB_HOST = 'localhost'; // TLS enforcement — local/private exception
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_MODEL = 'test-model';
    process.env.WISPACE_INTERNAL_KEY = 'test-wispace-key';
    process.env.WISPACE_API_PRECREATE_EXERCISE_URL =
      'https://testbackend.example.com/precreate-exercise';
    process.env.WISPACE_API_PRECREATE_EXERCISE_TIMEOUT_MS = '30000';
    process.env.DISCORD_BOT_TOKEN = 'fake-token';
    process.env.INTERNAL_API_KEY = 'test-internal-key';
    process.env.CHAT_FREE_FORM_DAILY_LIMIT = '15';
    process.env.CHAT_BURST_PER_MINUTE = '3';
    process.env.CHAT_USAGE_TIMEZONE = 'Asia/Ho_Chi_Minh';
    jest.spyOn(Client.prototype, 'login').mockResolvedValue('fake-token');

    const stubRepo = {} as Repository<unknown>;
    const dataSourceMock = new Proxy({} as DataSource, {
      get: (target, prop, receiver) => {
        if (prop === 'getRepository') return () => stubRepo;
        if (prop === 'hasMetadata') return () => true;
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

    const app = moduleRef.createNestApplication({ logger: false });
    try {
      await app.init();
      expect(moduleRef.get(InternalApiKeyGuard)).toBeInstanceOf(
        InternalApiKeyGuard,
      );
      expect(moduleRef.get(PrecreateExerciseApiClient)).toBeInstanceOf(
        PrecreateExerciseApiClient,
      );
      expect(moduleRef.get(DiscordOauthStateService)).toBeInstanceOf(
        DiscordOauthStateService,
      );
      expect(moduleRef.get(DiscordAccountLinkService)).toBeInstanceOf(
        DiscordAccountLinkService,
      );
      expect(moduleRef.get(DiscordLinkCompletionService)).toBeInstanceOf(
        DiscordLinkCompletionService,
      );
    } finally {
      await app.close();
    }
  }, 30_000);

  it('throws when INTERNAL_API_KEY is missing', async () => {
    delete process.env.INTERNAL_API_KEY;
    process.env.NODE_ENV = 'test';
    process.env.REDIS_ENABLED = 'false';
    process.env.DISCORD_BOT_TOKEN = 'fake-token';
    process.env.DB_HOST = 'localhost';
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_MODEL = 'test-model';
    process.env.WISPACE_INTERNAL_KEY = 'test-wispace-key';

    await expect(
      Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DataSource)
        .useValue({})
        .compile(),
    ).rejects.toThrow();
  }, 30_000);
});
