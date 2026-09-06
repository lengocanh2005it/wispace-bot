import './shared/common/tracing'; // MUST be first — initialises OTel SDK before any module loads
import { shutdownTracing } from './shared/common/tracing';
import { createShutdownHandler } from './shared/common/graceful-shutdown';
// vps-self-pull-deploy smoke test: no-op, verifies end-to-end self-pull deploy
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { errorMessage, sanitizeErrorStack } from '@wispace/bot-common/masking';
import { RedactedLogger } from '@wispace/bot-common/logging';
import {
  collectRuntimeSecretValues,
  registerRuntimeSecrets,
} from '@wispace/llm-agent';
import { AppModule } from './app.module';
import { parseJsonBodyLimit } from './shared/config/body-limit';
import { loadVaultSecrets } from './shared/config/vault-secrets';

const SHUTDOWN_LOGGER = new Logger('Shutdown');
// Must cover the longest in-flight work (LLM tool execution can take 35s)
// plus drain time for the debounce chat queue.
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 45_000;

process.on('unhandledRejection', (reason) => {
  SHUTDOWN_LOGGER.error(
    `Unhandled rejection: ${errorMessage(reason)}`,
    reason instanceof Error ? sanitizeErrorStack(reason.stack) : undefined,
  );
});

process.on('uncaughtException', (error) => {
  SHUTDOWN_LOGGER.error(
    `Uncaught exception: ${errorMessage(error)}`,
    sanitizeErrorStack(error.stack),
  );
  process.exit(1);
});

async function bootstrap() {
  await loadVaultSecrets();

  // No-secrets-in-model-context invariant (#632): register the process's
  // known secret values so every model-context boundary can redact them.
  const runtimeSecretCount = registerRuntimeSecrets(
    collectRuntimeSecretValues((key) => process.env[key]),
  );
  SHUTDOWN_LOGGER.log(`Registered ${runtimeSecretCount} runtime secrets`);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    // Global log redaction (#610): every Logger call passes digit-run
    // external-id masking before the transport. Must run before module
    // init so all Logger instances delegate to it.
    logger: new RedactedLogger(),
  });

  const bodyLimit = parseJsonBodyLimit(process.env.HTTP_JSON_BODY_LIMIT);
  app.useBodyParser('json', { limit: bodyLimit });
  app.useBodyParser('urlencoded', { limit: bodyLimit, extended: true });

  app.use(helmet());
  app.setGlobalPrefix('v1', { exclude: ['health', 'health/*path', 'metrics'] });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );

  app.enableShutdownHooks();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  SHUTDOWN_LOGGER.log(`Application listening on port ${port}`);

  // Single-owner graceful shutdown (#511): drain the app first, then flush
  // tracing, then exit. tracing.ts registers no signal handlers of its own.
  const shutdown = createShutdownHandler({
    app,
    shutdownTracing,
    timeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS,
    logger: SHUTDOWN_LOGGER,
    exit: (code) => process.exit(code),
  });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
void bootstrap();
