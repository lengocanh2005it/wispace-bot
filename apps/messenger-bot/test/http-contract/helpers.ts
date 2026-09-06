import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { App } from 'supertest/types';
import { InternalApiKeyGuard } from '@wispace/bot-common/guard';
import { ThrottlerGuard } from '@nestjs/throttler';

export interface ContractAppOptions {
  controllers: Type<unknown>[];
  providers: Array<{ provide: unknown; useValue: unknown }>;
  /** Guards to override with always-true (default: all three common guards). */
  overrideGuards?: Array<Type<unknown>>;
  /** Skip setting global prefix 'v1' (default: false). */
  skipPrefix?: boolean;
  /** Skip ValidationPipe (default: false). */
  skipValidation?: boolean;
  /** Skip overriding InternalApiKeyGuard (for auth-failure tests). */
  skipApiKeyGuardOverride?: boolean;
}

/**
 * Boot a partial Nest app for HTTP contract tests.
 * Overrides ThrottlerGuard, InternalApiKeyGuard, and any additional guards.
 * Always provides a fallback ConfigService so guards that need it don't crash.
 */
export async function createContractApp(
  opts: ContractAppOptions,
): Promise<INestApplication<App>> {
  const providers = [
    ...opts.providers,
    {
      provide: ConfigService,
      useValue:
        opts.providers.find((p) => p.provide === ConfigService)?.useValue ??
        ({ get: (key: string, fallback?: unknown) => fallback } as never),
    },
  ];

  const builder = Test.createTestingModule({
    controllers: opts.controllers,
    providers,
  })
    .overrideGuard(InternalApiKeyGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(ThrottlerGuard)
    .useValue({ canActivate: () => true });

  for (const guard of opts.overrideGuards ?? []) {
    builder.overrideGuard(guard).useValue({ canActivate: () => true });
  }

  const moduleFixture: TestingModule = await builder.compile();

  const app = moduleFixture.createNestApplication();

  if (!opts.skipPrefix) {
    app.setGlobalPrefix('v1');
  }

  if (!opts.skipValidation) {
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
  }

  await app.init();
  return app;
}
